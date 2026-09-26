#![allow(dead_code)]

use std::path::{Path, PathBuf};

use tokenstreak_core::engine::Engine;
use tokenstreak_core::readers::SourceConfig;
use tokenstreak_core::time::Clock;
use tokenstreak_core::Tool;

pub fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

/// A source config reading only the given roots (never the user's real logs).
pub fn sources(claude: Option<PathBuf>, codex: Option<PathBuf>, gemini: Option<PathBuf>) -> SourceConfig {
    let nowhere = PathBuf::from("/nonexistent/tokenstreak");
    SourceConfig {
        home: Some(nowhere.clone()),
        enabled: [claude.is_some(), codex.is_some(), gemini.is_some()],
        claude_dirs: Some(vec![claude.unwrap_or(nowhere.clone())]),
        codex_homes: Some(vec![codex.unwrap_or(nowhere.clone())]),
        gemini_dirs: Some(vec![gemini.unwrap_or(nowhere)]),
    }
}

pub fn fixture_sources() -> SourceConfig {
    let f = fixtures();
    sources(Some(f.join("claude/basic")), Some(f.join("codex/basic")), Some(f.join("gemini/basic")))
}

pub fn tool_root(tool: Tool) -> PathBuf {
    let f = fixtures();
    match tool {
        Tool::Claude => f.join("claude/basic"),
        Tool::Codex => f.join("codex/basic"),
        Tool::Gemini => f.join("gemini/basic"),
    }
}

pub fn engine(src: SourceConfig, tz: &str) -> Engine {
    let mut e = Engine::ephemeral(src, Clock::named(Some(tz)));
    e.scan();
    e.rebuild();
    e
}

pub const SENTINELS: [&str; 4] = [
    "TOKENSTREAK_SENTINEL_PROMPT_7f3a9c",
    "TOKENSTREAK_SENTINEL_RESPONSE_b21e44",
    "TOKENSTREAK_SENTINEL_THINKING_0d9e1a",
    "TOKENSTREAK_SENTINEL_TOOL_55c2f0",
];

pub fn assert_clean(label: &str, bytes: &[u8]) {
    for s in SENTINELS {
        assert!(
            memchr::memmem::find(bytes, s.as_bytes()).is_none(),
            "privacy violation: sentinel {s} found in {label}"
        );
        // Also the distinctive suffix, in case of partial copies.
        let tail = &s[s.len() - 6..];
        assert!(memchr::memmem::find(bytes, tail.as_bytes()).is_none(), "sentinel fragment {tail} found in {label}");
    }
}

/// Copies a directory tree.
pub fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let p = e.path();
        let t = to.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &t);
        } else {
            std::fs::copy(&p, &t).unwrap();
        }
    }
}
