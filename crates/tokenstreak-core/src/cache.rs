//! Incremental parse cache: every file's stamp, byte offset, reader state and
//! parsed events, so a relaunch only reads bytes appended since last time.
//!
//! Format: `TSCACHE` magic, format version, parser version, then a bincode
//! (varint) body. A version mismatch simply triggers a full rescan.

use std::io::Write;
use std::path::Path;

use bincode::Options;
use serde::{Deserialize, Serialize};

use crate::readers::FileRecord;

const MAGIC: &[u8; 7] = b"TSCACHE";
const FORMAT: u32 = 1;
/// Bump whenever parsing semantics change so caches are rebuilt.
pub const PARSER_VERSION: u32 = 3;

#[derive(Serialize, Deserialize)]
struct Body {
    files: Vec<FileRecord>,
}

fn opts() -> impl Options {
    bincode::DefaultOptions::new().with_varint_encoding().with_limit(2 * 1024 * 1024 * 1024)
}

pub fn load(path: &Path) -> Option<Vec<FileRecord>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 15 || &bytes[..7] != MAGIC {
        return None;
    }
    let format = u32::from_le_bytes(bytes[7..11].try_into().ok()?);
    let parser = u32::from_le_bytes(bytes[11..15].try_into().ok()?);
    if format != FORMAT || parser != PARSER_VERSION {
        return None;
    }
    opts().deserialize::<Body>(&bytes[15..]).ok().map(|b| b.files)
}

/// Streams the cache to disk (temp file, then rename) without building the
/// whole body in memory first: it is several MB for a big history, and was
/// serialized into two buffers on every rescan.
pub fn save(path: &Path, files: &[FileRecord]) -> std::io::Result<()> {
    #[derive(Serialize)]
    struct BodyRef<'a> {
        files: &'a [FileRecord],
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!("bin.tmp-{}", std::process::id()));
    let write = || -> std::io::Result<()> {
        let mut out = std::io::BufWriter::with_capacity(256 * 1024, std::fs::File::create(&tmp)?);
        out.write_all(MAGIC)?;
        out.write_all(&FORMAT.to_le_bytes())?;
        out.write_all(&PARSER_VERSION.to_le_bytes())?;
        opts().serialize_into(&mut out, &BodyRef { files }).map_err(std::io::Error::other)?;
        out.flush()
    };
    match write() {
        Ok(()) => std::fs::rename(&tmp, path),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}
