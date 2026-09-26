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

pub fn save(path: &Path, files: &[FileRecord]) -> std::io::Result<()> {
    #[derive(Serialize)]
    struct BodyRef<'a> {
        files: &'a [FileRecord],
    }
    let body = opts().serialize(&BodyRef { files }).map_err(std::io::Error::other)?;
    let mut out = Vec::with_capacity(body.len() + 15);
    out.write_all(MAGIC)?;
    out.write_all(&FORMAT.to_le_bytes())?;
    out.write_all(&PARSER_VERSION.to_le_bytes())?;
    out.write_all(&body)?;
    crate::state::write_atomic(path, &out)
}
