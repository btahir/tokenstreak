//! # tokenstreak-core
//!
//! Local, privacy-first reading of AI coding-agent usage logs (Claude Code,
//! Codex CLI, Gemini CLI), turned into daily history, goals, streaks,
//! achievements and cost estimates.
//!
//! Privacy contract: readers deserialise only usage numbers, model names,
//! timestamps and session/project identifiers. Prompt and response text is
//! never deserialised into owned values, stored, cached, exported or logged.
//! `tests/privacy.rs` enforces this with sentinel strings.
//!
//! Credits: parsing and cost semantics are ported from ccusage (MIT, ©
//! ryoppippi) so totals match it exactly; Tokscale (MIT, © Junho Yeo) informed
//! the incremental design. Prices come from LiteLLM (MIT, © Berri AI).

pub mod achievements;
pub mod aggregate;
pub mod api;
pub mod cache;
pub mod engine;
pub mod goals;
pub mod mock;
pub mod model;
pub mod notify;
pub mod pricing;
pub mod readers;
pub mod report;
pub mod state;
pub mod synth;
pub mod time;
#[cfg(feature = "watch")]
pub mod watch;

pub use engine::{Engine, ScanReport};
pub use model::Tool;
