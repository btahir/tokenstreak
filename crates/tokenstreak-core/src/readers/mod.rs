//! Log discovery and incremental, privacy-preserving parsing.
//!
//! Every reader uses typed partial deserialisation: the structs name only the
//! usage, model, timestamp and identifier fields. serde skips every other field
//! (prompts, responses, tool output, thinking) without allocating or storing
//! it, and nothing here logs line contents.
//!
//! Parsing semantics follow ccusage (MIT, © ryoppippi) so that daily totals
//! match it exactly; see `PLAN.md` for the correspondence and credits. Tokscale
//! (MIT, © Junho Yeo) informed the incremental-cache design.

pub mod claude;
pub mod codex;
pub mod gemini;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{RawEvent, Tool};

/// Per-file reader state carried across incremental parses.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub enum ReaderState {
    #[default]
    None,
    Codex(codex::CodexState),
    Gemini(gemini::GeminiState),
}

/// Codex session metadata used for fork/sub-agent replay detection.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CodexMeta {
    pub session_id: Option<String>,
    pub parent_id: Option<String>,
    pub forked_at_ms: Option<i64>,
    /// Timestamps of the first two token_count events (rewritten-burst probe).
    pub first_usage_ts: Vec<i64>,
}

/// Everything known about one log file. Persisted in the incremental cache.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct FileRecord {
    pub tool: Option<Tool>,
    pub path: PathBuf,
    /// Path relative to its source root, `/`-separated.
    pub rel: String,
    /// Index of the source root this file was found under (discovery order).
    pub root: u16,
    pub size: u64,
    pub mtime_ns: i128,
    pub inode: u64,
    /// Bytes consumed so far (always ends on a line boundary).
    pub offset: u64,
    /// Project key and human label (never shown in share cards unless opted in).
    pub project: String,
    pub project_label: String,
    pub models: Vec<String>,
    pub sessions: Vec<String>,
    /// Committed events from complete lines.
    pub events: Vec<RawEvent>,
    /// Events from a trailing line without a newline (re-read next time).
    pub provisional: Vec<RawEvent>,
    pub state: ReaderState,
    pub codex: CodexMeta,
    /// Whole-document formats (legacy Gemini `.json`) are reparsed from scratch.
    pub whole_document: bool,
    /// Number of lines that failed to parse as JSON (malformed), for diagnostics.
    pub malformed_lines: u32,
    /// True once the file has been parsed at least once.
    pub parsed: bool,
}

impl FileRecord {
    pub fn new(tool: Tool, path: PathBuf, rel: String, root: u16) -> Self {
        Self { tool: Some(tool), path, rel, root, ..Default::default() }
    }

    pub fn tool(&self) -> Tool {
        self.tool.unwrap_or(Tool::Claude)
    }

    pub fn intern_model(&mut self, name: &str) -> u32 {
        intern(&mut self.models, name)
    }

    pub fn intern_session(&mut self, name: &str) -> u32 {
        intern(&mut self.sessions, name)
    }

    pub fn all_events(&self) -> impl Iterator<Item = &RawEvent> {
        self.events.iter().chain(self.provisional.iter())
    }

    pub fn model_name(&self, idx: u32) -> Option<&str> {
        self.models.get(idx as usize).map(String::as_str)
    }

    fn reset(&mut self) {
        self.offset = 0;
        self.models.clear();
        self.sessions.clear();
        self.events.clear();
        self.provisional.clear();
        self.state = ReaderState::None;
        self.codex = CodexMeta::default();
        self.malformed_lines = 0;
        self.parsed = false;
    }
}

fn intern(table: &mut Vec<String>, name: &str) -> u32 {
    if let Some(i) = table.iter().rposition(|s| s == name) {
        return i as u32;
    }
    table.push(name.to_string());
    (table.len() - 1) as u32
}

/// File identity used to decide between reuse, append and full reparse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub size: u64,
    pub mtime_ns: i128,
    pub inode: u64,
}

pub fn stamp(path: &Path) -> Option<Stamp> {
    let md = std::fs::metadata(path).ok()?;
    if !md.is_file() {
        return None;
    }
    let mtime_ns = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(&md);
    #[cfg(not(unix))]
    let inode = 0;
    Some(Stamp { size: md.len(), mtime_ns, inode })
}

/// What an update did to a file record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UpdateKind {
    Unchanged,
    Appended,
    Reparsed,
}

/// Brings `rec` up to date with the file on disk, parsing only new bytes when
/// the file was appended to.
pub fn update_record(rec: &mut FileRecord, st: Stamp) -> std::io::Result<UpdateKind> {
    let unchanged = rec.size == st.size && rec.mtime_ns == st.mtime_ns && rec.inode == st.inode;
    if unchanged && rec.parsed {
        return Ok(UpdateKind::Unchanged);
    }
    let appendable = rec.parsed
        && !rec.whole_document
        && rec.inode == st.inode
        && st.size >= rec.size;
    let kind = if appendable { UpdateKind::Appended } else { UpdateKind::Reparsed };
    if kind == UpdateKind::Reparsed {
        rec.reset();
    }
    let mut file = File::open(&rec.path)?;
    let tool = rec.tool();
    if tool == Tool::Gemini && rec.path.extension().is_some_and(|e| e == "json") {
        rec.whole_document = true;
        let mut buf = Vec::with_capacity(st.size as usize);
        file.read_to_end(&mut buf)?;
        gemini::parse_json_document(rec, &buf, st.mtime_ns);
        rec.offset = buf.len() as u64;
    } else {
        file.seek(SeekFrom::Start(rec.offset))?;
        let mut buf = Vec::with_capacity(st.size.saturating_sub(rec.offset) as usize);
        file.read_to_end(&mut buf)?;
        let complete = match memchr::memrchr(b'\n', &buf) {
            Some(i) => i + 1,
            None => 0,
        };
        let (done, tail) = buf.split_at(complete);
        rec.provisional.clear();
        match tool {
            Tool::Claude => claude::parse_lines(rec, done, false),
            Tool::Codex => codex::parse_lines(rec, done, false, st.mtime_ns),
            Tool::Gemini => gemini::parse_lines(rec, done, false, st.mtime_ns),
        }
        rec.offset += complete as u64;
        if !tail.iter().all(|b| b.is_ascii_whitespace()) {
            // A trailing line without newline: count it (as ccusage does) but
            // keep it provisional so an in-progress write is re-read next time.
            match tool {
                Tool::Claude => claude::parse_lines(rec, tail, true),
                Tool::Codex => codex::parse_lines(rec, tail, true, st.mtime_ns),
                Tool::Gemini => gemini::parse_lines(rec, tail, true, st.mtime_ns),
            }
        }
    }
    rec.size = st.size;
    rec.mtime_ns = st.mtime_ns;
    rec.inode = st.inode;
    rec.parsed = true;
    Ok(kind)
}

/// Iterates the lines of a buffer (split on `\n`, trailing `\r` trimmed).
pub(crate) fn lines(buf: &[u8]) -> impl Iterator<Item = &[u8]> {
    buf.split(|b| *b == b'\n').filter_map(|l| {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        if l.iter().all(|b| b.is_ascii_whitespace()) {
            None
        } else {
            Some(l)
        }
    })
}

/// A directory scanned for one tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRoot {
    pub tool: Tool,
    pub dir: PathBuf,
    /// Files with the same relative path in an earlier root of the same
    /// dedup group win (Codex `sessions/` over `archived_sessions/`).
    pub dedup_group: Option<PathBuf>,
}

/// Where to look for logs. Built from env vars (ccusage-compatible), user
/// overrides and defaults.
#[derive(Clone, Debug, Default)]
pub struct SourceConfig {
    pub home: Option<PathBuf>,
    pub claude_dirs: Option<Vec<PathBuf>>,
    pub codex_homes: Option<Vec<PathBuf>>,
    pub gemini_dirs: Option<Vec<PathBuf>>,
    pub enabled: [bool; 3],
}

impl SourceConfig {
    /// Defaults for the current user, honouring `CLAUDE_CONFIG_DIR`,
    /// `CODEX_HOME` and `GEMINI_DATA_DIR` like ccusage does.
    pub fn from_env() -> Self {
        let split = |v: String| -> Vec<PathBuf> {
            v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(expand_home).collect()
        };
        Self {
            home: std::env::var_os("HOME").map(PathBuf::from),
            claude_dirs: std::env::var("CLAUDE_CONFIG_DIR").ok().map(split),
            codex_homes: std::env::var("CODEX_HOME").ok().map(split),
            gemini_dirs: std::env::var("GEMINI_DATA_DIR").ok().map(split),
            enabled: [true; 3],
        }
    }

    pub fn roots(&self) -> Vec<SourceRoot> {
        let mut roots = Vec::new();
        let home = self.home.clone().unwrap_or_else(|| PathBuf::from("/"));
        if self.enabled[Tool::Claude.index()] {
            let candidates: Vec<PathBuf> = match &self.claude_dirs {
                Some(dirs) => dirs
                    .iter()
                    .map(|p| {
                        if p.file_name().is_some_and(|n| n == "projects") && p.is_dir() {
                            p.parent().map(Path::to_path_buf).unwrap_or(p.clone())
                        } else {
                            p.clone()
                        }
                    })
                    .collect(),
                None => {
                    let xdg = std::env::var_os("XDG_CONFIG_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| home.join(".config"));
                    vec![xdg.join("claude"), home.join(".claude")]
                }
            };
            let mut seen = Vec::new();
            for c in candidates {
                let p = c.join("projects");
                if p.is_dir() && !seen.contains(&p) {
                    seen.push(p.clone());
                    roots.push(SourceRoot { tool: Tool::Claude, dir: p, dedup_group: None });
                }
            }
        }
        if self.enabled[Tool::Codex.index()] {
            let homes = self.codex_homes.clone().unwrap_or_else(|| vec![home.join(".codex")]);
            for h in homes {
                let sessions = h.join("sessions");
                let archived = h.join("archived_sessions");
                let mut any = false;
                for d in [sessions, archived] {
                    if d.is_dir() {
                        any = true;
                        roots.push(SourceRoot {
                            tool: Tool::Codex,
                            dir: d,
                            dedup_group: Some(h.clone()),
                        });
                    }
                }
                if !any && h.is_dir() {
                    roots.push(SourceRoot { tool: Tool::Codex, dir: h.clone(), dedup_group: Some(h) });
                }
            }
        }
        if self.enabled[Tool::Gemini.index()] {
            let dirs =
                self.gemini_dirs.clone().unwrap_or_else(|| vec![home.join(".gemini").join("tmp")]);
            for d in dirs {
                if d.is_dir() {
                    roots.push(SourceRoot { tool: Tool::Gemini, dir: d, dedup_group: None });
                }
            }
        }
        roots
    }
}

pub fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(h) = std::env::var_os("HOME") {
            return PathBuf::from(h).join(rest);
        }
    }
    PathBuf::from(raw)
}

/// A discovered log file.
#[derive(Clone, Debug)]
pub struct Discovered {
    pub tool: Tool,
    pub path: PathBuf,
    pub rel: String,
    pub root: u16,
}

/// Lists every log file under the roots, in ccusage's order (sorted by path
/// within a tool), dropping archived duplicates of active Codex sessions.
pub fn discover(roots: &[SourceRoot]) -> Vec<Discovered> {
    let mut out = Vec::new();
    let mut seen_codex: rustc_hash::FxHashSet<(PathBuf, String)> = Default::default();
    for (ri, root) in roots.iter().enumerate() {
        let mut files = Vec::new();
        collect(&root.dir, root.tool, &mut files);
        files.sort();
        for path in files {
            let rel = path
                .strip_prefix(&root.dir)
                .unwrap_or(&path)
                .components()
                .filter_map(|c| c.as_os_str().to_str())
                .collect::<Vec<_>>()
                .join("/");
            if let Some(group) = &root.dedup_group {
                if !seen_codex.insert((group.clone(), rel.clone())) {
                    continue;
                }
            }
            out.push(Discovered { tool: root.tool, path, rel, root: ri as u16 });
        }
    }
    out
}

fn collect(dir: &Path, tool: Tool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            collect(&path, tool, out);
        } else if ft.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let ok = match tool {
                Tool::Claude | Tool::Codex => ext == "jsonl",
                // Gemini CLI writes sessions to `<project>/chats/`; restricting to
                // those folders skips unrelated JSON (logs, checkpoints) in tmp.
                Tool::Gemini => {
                    (ext == "jsonl" || ext == "json")
                        && path.components().any(|c| c.as_os_str() == "chats")
                }
            };
            if ok {
                out.push(path);
            }
        }
    }
}

/// Serde helper: a string field that must not be an explicit JSON `null`
/// (ccusage rejects such lines). Missing → `Absent`.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub enum Field<T> {
    #[default]
    Absent,
    Null,
    Value(T),
}

impl<T> Field<T> {
    pub fn value(&self) -> Option<&T> {
        match self {
            Field::Value(v) => Some(v),
            _ => None,
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Field::Null)
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Field<T> {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(d)? {
            Some(v) => Field::Value(v),
            None => Field::Null,
        })
    }
}
