//! The typed IPC contract between the Rust backend and the web frontend.
//!
//! Every type here derives `ts_rs::TS`; `cargo test -p tokenstreak-core
//! export_bindings` regenerates `src/api/generated/*.ts`. The browser mock
//! backend serves the same shapes. Keep this file the single source of truth.
//!
//! Numbers: token counts are plain JSON numbers (safe up to 2^53).
//! Dates are local calendar dates `YYYY-MM-DD`; instants are RFC 3339 strings.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{TokenCounts, Tool};

pub const SCHEMA_VERSION: u32 = 1;

/// Everything the popover and the dashboard's overview need, in one payload.
/// Emitted as the `snapshot` event whenever data changes.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppSnapshot {
    pub schema_version: u32,
    /// When this snapshot was computed (RFC 3339).
    pub generated_at: String,
    /// IANA zone used for day bucketing.
    pub timezone: String,
    pub today: TodayView,
    pub streak: StreakView,
    pub goals: GoalsView,
    /// Dense daily history from the first active day to today (ascending).
    pub days: Vec<DayRow>,
    /// Weekly totals (ascending, weeks start on `goals.weekStartsOn`).
    pub weeks: Vec<PeriodRow>,
    /// Monthly totals (ascending).
    pub months: Vec<PeriodRow>,
    pub lifetime: LifetimeView,
    pub achievements: Vec<Achievement>,
    pub sources: Vec<SourceStatus>,
    pub pricing: PricingInfo,
    pub status: EngineStatus,
    pub onboarding: OnboardingView,
    /// A goal-reached moment not yet acknowledged by the UI (for the confetti).
    pub celebration: Option<Celebration>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TodayView {
    pub date: String,
    pub tokens: TokenCounts,
    /// Estimated USD.
    pub cost: f64,
    #[ts(type = "number")]
    pub goal: u64,
    /// tokens.total / goal (may exceed 1).
    pub progress: f64,
    pub met: bool,
    #[ts(type = "number")]
    pub remaining: u64,
    pub by_tool: Vec<ToolSlice>,
    /// Tokens per local hour 0..23.
    #[ts(type = "Array<number>")]
    pub hourly: Vec<u64>,
    pub sessions: u32,
    pub messages: u32,
    pub last_activity_at: Option<String>,
    /// Today's total relative to the average of the last 30 active days (1 = average).
    pub vs_recent_average: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ToolSlice {
    pub tool: Tool,
    #[ts(type = "number")]
    pub tokens: u64,
    pub cost: f64,
    /// Share of the period's total tokens (0..1).
    pub share: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StreakView {
    /// Consecutive days meeting the daily goal, ending today if today is met,
    /// otherwise ending yesterday (today is still in progress).
    pub current: u32,
    pub longest: u32,
    pub longest_start: Option<String>,
    pub longest_end: Option<String>,
    pub current_start: Option<String>,
    pub today_met: bool,
    /// A streak is alive but today's goal is not met yet.
    pub at_risk: bool,
    /// Consecutive weeks meeting the weekly goal (current week counts once met).
    pub weekly_current: u32,
    pub weekly_longest: u32,
    /// Weekdays (0 = Monday) that neither break nor extend a streak.
    pub rest_days: Vec<u8>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GoalsView {
    #[ts(type = "number")]
    pub daily: u64,
    #[ts(type = "number")]
    pub weekly: u64,
    pub week_starts_on: WeekStart,
    pub this_week: WeekProgress,
    pub history: Vec<GoalChange>,
    /// Suggested goals from recent history (for onboarding and settings).
    #[ts(type = "number")]
    pub suggested_daily: u64,
    #[ts(type = "number")]
    pub suggested_weekly: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WeekProgress {
    pub start: String,
    pub end: String,
    #[ts(type = "number")]
    pub tokens: u64,
    #[ts(type = "number")]
    pub goal: u64,
    pub progress: f64,
    pub met: bool,
    pub days_left: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum WeekStart {
    #[default]
    Monday,
    Sunday,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GoalChange {
    /// First local date this goal applies to.
    pub effective_from: String,
    #[ts(type = "number")]
    pub daily: u64,
    #[ts(type = "number")]
    pub weekly: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DayRow {
    pub date: String,
    #[ts(type = "number")]
    pub total: u64,
    pub cost: f64,
    #[ts(type = "number")]
    pub claude: u64,
    #[ts(type = "number")]
    pub codex: u64,
    #[ts(type = "number")]
    pub gemini: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    /// Uncached input tokens (excludes cache reads and writes).
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    pub messages: u32,
    pub sessions: u32,
    /// Daily goal in effect on this date.
    #[ts(type = "number")]
    pub goal: u64,
    pub met: bool,
    /// Streak length at the end of this day (0 when not met).
    pub streak: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PeriodRow {
    /// Week start date or `YYYY-MM`.
    pub key: String,
    pub start: String,
    pub end: String,
    #[ts(type = "number")]
    pub total: u64,
    pub cost: f64,
    #[ts(type = "number")]
    pub claude: u64,
    #[ts(type = "number")]
    pub codex: u64,
    #[ts(type = "number")]
    pub gemini: u64,
    pub active_days: u32,
    /// Weekly rows: weekly goal in effect and whether it was met.
    #[ts(type = "number | null")]
    pub goal: Option<u64>,
    pub met: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LifetimeView {
    pub tokens: TokenCounts,
    pub cost: f64,
    pub active_days: u32,
    pub first_date: Option<String>,
    pub sessions: u32,
    pub messages: u32,
    pub best_day: Option<BestDay>,
    pub favorite_tool: Option<Tool>,
    pub favorite_model: Option<String>,
    pub models_used: u32,
    pub projects: u32,
    /// Estimated USD saved by prompt caching.
    pub cache_savings: f64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BestDay {
    pub date: String,
    #[ts(type = "number")]
    pub tokens: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AchievementTier {
    Bronze,
    Silver,
    Gold,
    Legendary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AchievementCategory {
    Streak,
    Volume,
    Goals,
    Explorer,
    Habits,
    Efficiency,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Achievement {
    /// Stable id, e.g. `streak-7`.
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: AchievementCategory,
    pub tier: AchievementTier,
    /// Local date it was unlocked, `null` while locked.
    pub unlocked_at: Option<String>,
    /// Progress towards unlocking (current / target, same unit).
    pub progress: f64,
    pub target: f64,
    /// Unlocked since the UI last acknowledged achievements.
    pub is_new: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SourceStatus {
    pub tool: Tool,
    pub name: String,
    pub enabled: bool,
    /// At least one log folder exists.
    pub found: bool,
    pub paths: Vec<String>,
    pub files: u32,
    pub events: u32,
    pub first_activity: Option<String>,
    pub last_activity: Option<String>,
    #[ts(type = "number")]
    pub total_tokens: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PricingInfo {
    pub source: String,
    pub license: String,
    /// When the price list was fetched (RFC 3339 or date).
    pub updated_at: String,
    pub model_count: u32,
    /// Models seen in logs with no price (their cost counts as 0).
    pub unpriced_models: Vec<String>,
    /// Costs are estimates, not bills.
    pub is_estimate: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EngineStatus {
    pub last_scan_at: Option<String>,
    pub last_scan_ms: u32,
    pub files: u32,
    pub events: u32,
    pub duplicates_removed: u32,
    pub malformed_lines: u32,
    /// True while the very first full scan is running.
    pub initial_scan: bool,
    pub watching: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OnboardingView {
    pub completed: bool,
    pub tools_found: Vec<Tool>,
    pub first_activity: Option<String>,
    pub active_days: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Celebration {
    pub date: String,
    #[ts(type = "number")]
    pub tokens: u64,
    #[ts(type = "number")]
    pub goal: u64,
    /// Streak including today.
    pub streak: u32,
    /// True when this also set a new longest streak.
    pub new_record: bool,
}

// ---------------------------------------------------------------------------
// Breakdowns

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum RangeKind {
    Today,
    Yesterday,
    Last7,
    Last30,
    Last90,
    ThisWeek,
    ThisMonth,
    ThisYear,
    All,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RangeQuery {
    pub kind: RangeKind,
    /// Inclusive `YYYY-MM-DD` bounds for `custom`.
    #[ts(optional)]
    pub from: Option<String>,
    #[ts(optional)]
    pub to: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Breakdown {
    pub from: String,
    pub to: String,
    pub totals: TokenCounts,
    pub cost: f64,
    pub active_days: u32,
    pub sessions: u32,
    pub messages: u32,
    pub by_tool: Vec<Slice>,
    pub by_model: Vec<Slice>,
    pub by_project: Vec<Slice>,
    /// Largest sessions in the range (ids are opaque; labels are project names).
    pub top_sessions: Vec<SessionRow>,
    #[ts(type = "Array<number>")]
    pub hourly: Vec<u64>,
    /// Tokens per weekday, 0 = Monday.
    #[ts(type = "Array<number>")]
    pub weekday: Vec<u64>,
    pub efficiency: Efficiency,
    /// One point per day in the range.
    pub series: Vec<DayRow>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Slice {
    pub key: String,
    pub label: String,
    /// Set for model slices: the tool the model was used through.
    pub tool: Option<Tool>,
    pub tokens: TokenCounts,
    pub cost: f64,
    pub share: f64,
    pub messages: u32,
    pub sessions: u32,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionRow {
    pub id: String,
    pub tool: Tool,
    pub project: String,
    pub started_at: String,
    pub ended_at: String,
    #[ts(type = "number")]
    pub tokens: u64,
    pub cost: f64,
    pub messages: u32,
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Efficiency {
    /// cacheRead / (input + cacheRead + cacheWrite).
    pub cache_read_share: f64,
    pub cache_write_share: f64,
    /// output / total.
    pub output_share: f64,
    pub cost_per_active_day: f64,
    pub cost_per_million: f64,
    pub tokens_per_session: f64,
    pub tokens_per_message: f64,
    pub cache_savings: f64,
}

// ---------------------------------------------------------------------------
// Settings and sharing

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MenuBarDisplay {
    /// Icon only.
    #[default]
    Icon,
    /// Icon plus today's tokens, e.g. "4.2M".
    Today,
    /// Icon plus the current streak, e.g. "12d".
    Streak,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ToolSettings {
    pub enabled: bool,
    /// Extra or replacement log folders (empty = auto-detect).
    pub custom_paths: Vec<String>,
}

impl Default for ToolSettings {
    fn default() -> Self {
        Self { enabled: true, custom_paths: Vec::new() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct NotificationSettings {
    pub goal_reached: bool,
    pub achievements: bool,
    /// Evening nudge when a streak is at risk (off by default). Fires at most
    /// once a day, at or after `reminderTime`, never on rest days or in quiet hours.
    pub streak_at_risk: bool,
    /// Local time `HH:MM` for the streak-at-risk reminder.
    pub reminder_time: String,
    /// No notifications of any kind during these hours.
    pub quiet_hours: QuietHours,
    /// A short recap of last week, once, on the first day of the week
    /// (at or after 09:00, off by default).
    pub weekly_recap: bool,
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            goal_reached: true,
            achievements: true,
            streak_at_risk: false,
            reminder_time: "20:00".into(),
            quiet_hours: QuietHours::default(),
            weekly_recap: false,
        }
    }
}

/// A daily quiet window in local time; `start > end` wraps past midnight.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct QuietHours {
    pub enabled: bool,
    /// `HH:MM`, inclusive.
    pub start: String,
    /// `HH:MM`, exclusive.
    pub end: String,
}

impl Default for QuietHours {
    fn default() -> Self {
        Self { enabled: false, start: "22:00".into(), end: "08:00".into() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct ShareSettings {
    /// Project names appear on share cards only when true.
    pub show_project_names: bool,
    pub show_cost: bool,
    /// Show the per-tool mix on share cards.
    pub show_agent_mix: bool,
}

impl Default for ShareSettings {
    fn default() -> Self {
        Self { show_project_names: false, show_cost: false, show_agent_mix: true }
    }
}


#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
#[derive(Default)]
pub struct ToolsSettings {
    pub claude: ToolSettings,
    pub codex: ToolSettings,
    pub gemini: ToolSettings,
}


/// User preferences, persisted as `settings.json` in the app data folder.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct Settings {
    #[ts(type = "number")]
    pub daily_goal: u64,
    #[ts(type = "number")]
    pub weekly_goal: u64,
    pub week_starts_on: WeekStart,
    /// Weekdays (0 = Monday) that don't break streaks.
    pub rest_days: Vec<u8>,
    /// IANA zone override; `null` = system zone.
    pub timezone: Option<String>,
    pub tools: ToolsSettings,
    pub notifications: NotificationSettings,
    pub launch_at_login: bool,
    pub menu_bar: MenuBarDisplay,
    pub theme: Theme,
    /// Celebration sound (off by default).
    pub sound: bool,
    /// Sound volume, 0..1.
    pub sound_volume: f64,
    pub share: ShareSettings,
    /// Keep history from log files the tools have since deleted.
    pub keep_deleted_history: bool,
    /// Codex: price unrecorded-tier requests as priority ("fast").
    pub codex_fast_tier: Option<bool>,
    /// Global keyboard shortcut that toggles the popover, in Tauri accelerator
    /// syntax (e.g. `"Alt+Shift+T"`, `"CmdOrCtrl+Shift+K"`); `null` = off (default).
    pub popover_shortcut: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            daily_goal: 0,
            weekly_goal: 0,
            week_starts_on: WeekStart::Monday,
            rest_days: Vec::new(),
            timezone: None,
            tools: ToolsSettings::default(),
            notifications: NotificationSettings::default(),
            launch_at_login: false,
            menu_bar: MenuBarDisplay::Icon,
            theme: Theme::System,
            sound: false,
            sound_volume: 0.6,
            share: ShareSettings::default(),
            keep_deleted_history: true,
            codex_fast_tier: None,
            popover_shortcut: None,
        }
    }
}

/// Input for `set_goals` / `complete_onboarding`.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GoalsInput {
    #[ts(type = "number")]
    pub daily: u64,
    #[ts(type = "number")]
    pub weekly: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ShareFormat {
    /// 1:1 square.
    Square,
    /// 9:16 story.
    Story,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShareOptions {
    pub range: RangeQuery,
    pub format: ShareFormat,
    /// Overrides the saved preference for this card only.
    #[ts(optional)]
    pub include_project_names: Option<bool>,
}

/// Privacy-filtered data for rendering a share card. Project names are
/// absent unless explicitly allowed; there are never paths or session ids.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ShareCardData {
    pub format: ShareFormat,
    pub range_label: String,
    pub from: String,
    pub to: String,
    #[ts(type = "number")]
    pub total_tokens: u64,
    pub cost: Option<f64>,
    pub streak: u32,
    pub longest_streak: u32,
    pub active_days: u32,
    pub goal_days_met: u32,
    pub by_tool: Vec<ToolSlice>,
    pub top_models: Vec<String>,
    /// Only present when project names are allowed.
    pub top_projects: Option<Vec<String>>,
    /// Daily totals for a mini heatmap / sparkline.
    #[ts(type = "Array<number>")]
    pub daily: Vec<u64>,
    pub achievements_unlocked: u32,
    pub cache_read_share: f64,
}

/// Result of `refresh_prices`.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PriceRefreshResult {
    pub ok: bool,
    pub pricing: PricingInfo,
    pub error: Option<String>,
}

/// Progress of a scan (`scan-progress` event).
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScanProgress {
    /// `"initial"` while the first scan streams partial results, `"done"` at the end.
    pub phase: String,
    pub files_done: u32,
    pub files_total: u32,
    #[ts(type = "number")]
    pub bytes_done: u64,
    #[ts(type = "number")]
    pub bytes_total: u64,
}

/// Static information about the running app (`get_app_info`).
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AppInfo {
    pub version: String,
    /// Folder holding settings, state and the usage cache.
    pub data_dir: String,
    /// `"tauri"` in the app, `"mock"` in the browser mock.
    pub backend: String,
    pub launch_at_login: bool,
    pub notifications_permitted: Option<bool>,
}
