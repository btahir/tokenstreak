//! Structured logging to `~/Library/Logs/app.tokenstreak.desktop/`.
//!
//! One JSON object per line (timestamp, level, target, message, fields). The
//! app only ever logs counts, timings, states and error kinds: never log
//! content, prompts or responses (the core's privacy test enforces this for
//! everything the engine logs). The file is capped: past `MAX_BYTES` it is
//! rotated to `tokenstreak.log.1`, so at most two files exist.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::prelude::*;
use tracing_subscriber::EnvFilter;

pub const FILE_NAME: &str = "tokenstreak.log";
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// A size-capped, rotating log file.
#[derive(Clone)]
pub struct LogFile {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    max: u64,
}

impl LogFile {
    pub fn open(dir: &Path) -> io::Result<Self> {
        Self::with_limit(dir, MAX_BYTES)
    }

    pub fn with_limit(dir: &Path, max: u64) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(FILE_NAME);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut inner = Inner { path, file: Some(file), written, max };
        if inner.written > inner.max {
            inner.rotate();
        }
        Ok(Self { inner: Arc::new(Mutex::new(inner)) })
    }
}

impl Inner {
    fn rotate(&mut self) {
        self.file = None;
        let old = self.path.with_extension("log.1");
        let _ = std::fs::rename(&self.path, old);
        self.file = OpenOptions::new().create(true).append(true).open(&self.path).ok();
        self.written = 0;
    }
}

pub struct Guard<'a>(parking_lot::MutexGuard<'a, Inner>);

impl Write for Guard<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let inner = &mut *self.0;
        if inner.written + buf.len() as u64 > inner.max {
            inner.rotate();
        }
        match inner.file.as_mut() {
            Some(f) => {
                let n = f.write(buf)?;
                inner.written += n as u64;
                Ok(n)
            }
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.0.file.as_mut() {
            Some(f) => f.flush(),
            None => Ok(()),
        }
    }
}

impl<'a> MakeWriter<'a> for LogFile {
    type Writer = Guard<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        Guard(self.inner.lock())
    }
}

/// Installs the global subscriber: JSON lines to the log file (info by
/// default, `TOKENSTREAK_LOG` overrides), plus readable stderr output in
/// debug builds. Falls back to stderr alone if the folder is unwritable.
pub fn init(dir: Option<&Path>) {
    let filter = || EnvFilter::try_from_env("TOKENSTREAK_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let file = dir.and_then(|d| LogFile::open(d).ok());
    let file_layer = file.map(|f| {
        tracing_subscriber::fmt::layer()
            .json()
            .with_current_span(false)
            .with_span_list(false)
            .with_writer(f)
            .with_filter(filter())
    });
    let stderr_layer = (cfg!(debug_assertions) || dir.is_none())
        .then(|| tracing_subscriber::fmt::layer().with_writer(io::stderr).with_filter(filter()));
    let _ = tracing_subscriber::registry().with(file_layer).with(stderr_layer).try_init();

    // A panic aborts the release build; record where it happened first. The
    // payload is not logged (it is never needed to locate the bug).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        tracing::error!(%location, "panic");
        default_hook(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_past_the_limit_and_keeps_two_files() {
        let dir = tempfile::tempdir().unwrap();
        let log = LogFile::with_limit(dir.path(), 100).unwrap();
        for i in 0..10 {
            let mut w = log.make_writer();
            writeln!(w, "{{\"line\":{i},\"pad\":\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"}}").unwrap();
        }
        let main = std::fs::metadata(dir.path().join(FILE_NAME)).unwrap().len();
        let old = std::fs::metadata(dir.path().join("tokenstreak.log.1")).unwrap().len();
        assert!(main <= 100 && old <= 100, "{main} {old}");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn reopening_an_oversized_log_rotates_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), vec![b'x'; 500]).unwrap();
        let _log = LogFile::with_limit(dir.path(), 100).unwrap();
        assert_eq!(std::fs::metadata(dir.path().join(FILE_NAME)).unwrap().len(), 0);
    }
}
