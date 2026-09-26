//! Persisted settings and app state (JSON files in the app data folder).
//!
//! Writes are atomic (temp file + rename). Neither file ever contains log
//! content: only preferences, goal history, acknowledgement markers and
//! unlock dates.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::api::{GoalChange, Settings};

/// Non-preference state the app keeps between launches.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub version: u32,
    pub installed_at: Option<String>,
    pub onboarding_completed_at: Option<String>,
    /// Versioned goals (see `goals.rs`).
    pub goal_history: Vec<GoalChange>,
    /// Dates whose goal-reached moment the UI has already celebrated.
    pub celebrated_dates: Vec<String>,
    /// Sticky achievement unlock dates by id.
    pub unlocked: BTreeMap<String, String>,
    /// Achievement ids the UI has shown.
    pub seen_achievements: BTreeSet<String>,
    pub prices_updated_at: Option<String>,
}

pub struct Store {
    dir: PathBuf,
}

pub const SETTINGS_FILE: &str = "settings.json";
pub const STATE_FILE: &str = "state.json";
pub const CACHE_FILE: &str = "usage-cache.bin";
pub const PRICES_FILE: &str = "prices.json";

impl Store {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    pub fn load_settings(&self) -> Settings {
        read_json(&self.path(SETTINGS_FILE)).unwrap_or_default()
    }

    pub fn save_settings(&self, s: &Settings) -> std::io::Result<()> {
        write_json(&self.path(SETTINGS_FILE), s)
    }

    pub fn load_state(&self) -> AppState {
        read_json(&self.path(STATE_FILE)).unwrap_or_default()
    }

    pub fn save_state(&self, s: &AppState) -> std::io::Result<()> {
        write_json(&self.path(STATE_FILE), s)
    }
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub fn write_json<T: Serialize>(path: &Path, v: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(v).map_err(std::io::Error::other)?;
    write_atomic(path, &bytes)
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp-{}",
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// Deep-merges a JSON patch into settings (objects merge, other values replace).
pub fn merge_settings(current: &Settings, patch: &serde_json::Value) -> Result<Settings, String> {
    let mut base = serde_json::to_value(current).map_err(|e| e.to_string())?;
    merge(&mut base, patch);
    serde_json::from_value(base).map_err(|e| e.to_string())
}

fn merge(a: &mut serde_json::Value, b: &serde_json::Value) {
    match (a, b) {
        (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (a, b) => *a = b.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_merges_nested() {
        let s = Settings::default();
        let p = serde_json::json!({"dailyGoal": 5, "share": {"showCost": true}});
        let m = merge_settings(&s, &p).unwrap();
        assert_eq!(m.daily_goal, 5);
        assert!(m.share.show_cost);
        assert!(!m.share.show_project_names);
    }

    #[test]
    fn round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let st = Store::new(dir.path());
        let mut s = Settings::default();
        s.daily_goal = 42;
        st.save_settings(&s).unwrap();
        assert_eq!(st.load_settings().daily_goal, 42);
    }
}
