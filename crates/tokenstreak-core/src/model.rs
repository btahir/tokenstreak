//! Core data model shared by readers, the cache and aggregation.
//!
//! Only usage numbers, model names, timestamps and session/project identifiers
//! ever enter these types. There is deliberately no field that could hold
//! prompt or response text.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A supported AI coding agent.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS,
)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Tool {
    #[default]
    Claude,
    Codex,
    Gemini,
}

impl Tool {
    pub const ALL: [Tool; 3] = [Tool::Claude, Tool::Codex, Tool::Gemini];

    pub fn as_str(self) -> &'static str {
        match self {
            Tool::Claude => "claude",
            Tool::Codex => "codex",
            Tool::Gemini => "gemini",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Tool::Claude => "Claude Code",
            Tool::Codex => "Codex CLI",
            Tool::Gemini => "Gemini CLI",
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

/// Bit flags on a [`RawEvent`].
pub mod flags {
    /// Claude: the entry was written by a sidechain (sub-agent / `/btw`) log.
    pub const SIDECHAIN: u8 = 1 << 0;
    /// Claude: `usage.speed == "fast"` (priced with the model's fast multiplier).
    pub const FAST: u8 = 1 << 1;
    /// Claude: `usage.speed` was present (either value). Used by dedup tie-breaks.
    pub const HAS_SPEED: u8 = 1 << 2;
    /// Codex: model was not recorded and fell back to a default.
    pub const FALLBACK_MODEL: u8 = 1 << 3;
    /// Codex: the recorded service tier was standard.
    pub const TIER_STANDARD: u8 = 1 << 4;
    /// Codex: the recorded service tier was fast / priority.
    pub const TIER_FAST: u8 = 1 << 5;
    /// Claude: the model was `<synthetic>` (tokens count, no model / cost).
    pub const SYNTHETIC: u8 = 1 << 6;
}

/// Sentinel for "no model" in [`RawEvent::model`].
pub const NO_MODEL: u32 = u32::MAX;

/// One usage record as parsed from a log line, before cross-file dedup.
///
/// Token fields are normalised to the Claude shape used by ccusage:
/// `input` excludes cache reads and cache writes; `output` includes reasoning
/// for Codex; `extra` holds tokens counted in the total but outside the four
/// classic buckets (Gemini "thoughts").
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RawEvent {
    /// Unix epoch milliseconds (UTC).
    pub ts_ms: i64,
    /// Index into the owning file's `models` table, or [`NO_MODEL`].
    pub model: u32,
    /// Index into the owning file's `sessions` table.
    pub session: u32,
    pub input: u64,
    pub output: u64,
    pub cache_create_5m: u64,
    pub cache_create_1h: u64,
    pub cache_read: u64,
    /// Reasoning tokens. For Codex this is a subset of `output` (informational).
    pub reasoning: u64,
    /// Tokens that count toward the total but sit outside input/output/cache.
    pub extra: u64,
    /// Source-reported total (Codex `total_tokens`, Gemini `total`), used only
    /// for replay matching. Zero when absent.
    pub total_raw: u64,
    /// Cost recorded by the tool itself (Claude `costUSD`), used in auto mode.
    pub recorded_cost: Option<f64>,
    /// Hash of the provider message id (Claude dedup, Gemini replace-by-id).
    pub msg_id: Option<u64>,
    /// Hash of the request id (Claude dedup).
    pub req_id: Option<u64>,
    pub flags: u8,
}

impl RawEvent {
    pub fn cache_create(&self) -> u64 {
        self.cache_create_5m.saturating_add(self.cache_create_1h)
    }

    /// ccusage-compatible total: input + output + cache writes + cache reads + extra.
    pub fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache_create())
            .saturating_add(self.cache_read)
            .saturating_add(self.extra)
    }

    pub fn has(&self, flag: u8) -> bool {
        self.flags & flag != 0
    }
}

/// Summed token counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TokenCounts {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    /// Reasoning tokens where the tool reports them (informational, already
    /// included in `output` for Codex and in `other` for Gemini).
    #[ts(type = "number")]
    pub reasoning: u64,
    /// Tokens counted in the total outside the four classic buckets.
    #[ts(type = "number")]
    pub other: u64,
    #[ts(type = "number")]
    pub total: u64,
}

impl TokenCounts {
    pub fn add_event(&mut self, e: &RawEvent) {
        self.input += e.input;
        self.output += e.output;
        self.cache_write += e.cache_create();
        self.cache_read += e.cache_read;
        self.reasoning += e.reasoning;
        self.other += e.extra;
        self.total += e.total();
    }

    pub fn add(&mut self, o: &TokenCounts) {
        self.input += o.input;
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.cache_read += o.cache_read;
        self.reasoning += o.reasoning;
        self.other += o.other;
        self.total += o.total;
    }

    /// Share of prompt-side tokens that were served from cache (0..=1).
    pub fn cache_read_share(&self) -> f64 {
        let prompt = self.input + self.cache_read + self.cache_write;
        if prompt == 0 {
            0.0
        } else {
            self.cache_read as f64 / prompt as f64
        }
    }
}

/// Stable 64-bit FNV-1a hash used for dedup keys (ids are never stored).
pub fn hash_str(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn hash_parts(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for p in parts {
        for b in *p {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
