//! Cost estimates from a bundled open-source price list.
//!
//! Source: LiteLLM's `model_prices_and_context_window.json` (MIT, © Berri AI),
//! the same list ccusage uses. A compacted snapshot is embedded at build time
//! (`prices.snapshot.json`); the user may refresh it, which is the product's
//! only network call. Lookup and cost rules follow ccusage (MIT) so estimates
//! agree with it.

use std::collections::BTreeMap;
use std::sync::RwLock;

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

pub const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const EMBEDDED: &str = include_str!("prices.snapshot.json");
const FAST_OVERRIDES: &str = include_str!("fast-multipliers.json");
const DEFAULT_LONG_CONTEXT: u64 = 200_000;
const CACHE_CREATE_1H_MULTIPLIER: f64 = 2.0;

/// Per-token USD rates for one model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pricing {
    pub input: f64,
    pub output: f64,
    pub cache_create: f64,
    pub cache_read: f64,
    pub cache_read_explicit: bool,
    pub input_above: Option<f64>,
    pub output_above: Option<f64>,
    pub cache_create_above: Option<f64>,
    pub cache_read_above: Option<f64>,
    /// Whole-request long-context switch (e.g. OpenAI 272K). `None` means
    /// LiteLLM's marginal `*_above_200k_tokens` semantics.
    pub long_context_threshold: Option<u64>,
    pub fast_multiplier: f64,
}

/// Compact on-disk row: [i, o, cc, cr, ia, oa, cca, cra, lt, fast].
#[derive(Serialize, Deserialize)]
struct Row(
    f64,
    f64,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<f64>,
    Option<u64>,
    Option<f64>,
);

#[derive(Serialize, Deserialize)]
struct Compact {
    source: String,
    license: String,
    #[serde(rename = "fetchedAt")]
    fetched_at: String,
    models: BTreeMap<String, Row>,
}

/// Metadata about the loaded price list.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PriceMeta {
    pub source: String,
    pub fetched_at: String,
    pub model_count: usize,
}

pub struct PriceTable {
    entries: FxHashMap<String, Pricing>,
    compact: BTreeMap<String, [Option<f64>; 10]>,
    pub meta: PriceMeta,
    cache: RwLock<FxHashMap<String, Option<Pricing>>>,
}

impl std::fmt::Debug for PriceTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PriceTable").field("meta", &self.meta).finish()
    }
}

impl PriceTable {
    /// The snapshot bundled with the app.
    pub fn embedded() -> Self {
        Self::from_compact(EMBEDDED).expect("embedded price snapshot parses")
    }

    pub fn from_compact(json: &str) -> Result<Self, String> {
        let c: Compact = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut rows = BTreeMap::new();
        for (k, r) in c.models {
            rows.insert(k, [Some(r.0), Some(r.1), r.2, r.3, r.4, r.5, r.6, r.7, r.8.map(|v| v as f64), r.9]);
        }
        Ok(Self::build(rows, PriceMeta { source: c.source, fetched_at: c.fetched_at, model_count: 0 }))
    }

    /// Builds a table from a full LiteLLM price file.
    pub fn from_litellm(json: &str, fetched_at: &str) -> Result<Self, String> {
        let raw: BTreeMap<String, serde_json::Value> =
            serde_json::from_str(json).map_err(|e| e.to_string())?;
        let mut rows = BTreeMap::new();
        for (model, v) in raw {
            let Some(o) = v.as_object() else { continue };
            let f = |k: &str| o.get(k).and_then(|x| x.as_f64());
            let (Some(i), Some(out)) = (f("input_cost_per_token"), f("output_cost_per_token")) else {
                continue;
            };
            let (mut ia, mut oa, mut cca, mut cra, mut lt) = (
                f("input_cost_per_token_above_200k_tokens"),
                f("output_cost_per_token_above_200k_tokens"),
                f("cache_creation_input_token_cost_above_200k_tokens"),
                f("cache_read_input_token_cost_above_200k_tokens"),
                None,
            );
            if ia.is_none() && oa.is_none() {
                // Other thresholds (e.g. OpenAI's 272K) switch the whole request.
                for (key, _) in o.iter() {
                    if let Some(n) = key
                        .strip_prefix("input_cost_per_token_above_")
                        .and_then(|r| r.strip_suffix("k_tokens"))
                        .and_then(|n| n.parse::<u64>().ok())
                    {
                        let sfx = format!("_above_{n}k_tokens");
                        ia = f(&format!("input_cost_per_token{sfx}"));
                        oa = f(&format!("output_cost_per_token{sfx}"));
                        cca = f(&format!("cache_creation_input_token_cost{sfx}"));
                        cra = f(&format!("cache_read_input_token_cost{sfx}"));
                        lt = Some((n * 1000) as f64);
                        break;
                    }
                }
            }
            let fast = o
                .get("provider_specific_entry")
                .and_then(|p| p.get("fast"))
                .and_then(|x| x.as_f64());
            rows.insert(
                model,
                [
                    Some(i),
                    Some(out),
                    f("cache_creation_input_token_cost"),
                    f("cache_read_input_token_cost"),
                    ia,
                    oa,
                    cca,
                    cra,
                    lt,
                    fast,
                ],
            );
        }
        if rows.len() < 50 {
            return Err("price list looks incomplete".into());
        }
        Ok(Self::build(
            rows,
            PriceMeta { source: "LiteLLM model_prices_and_context_window.json (MIT)".into(), fetched_at: fetched_at.into(), model_count: 0 },
        ))
    }

    fn build(rows: BTreeMap<String, [Option<f64>; 10]>, mut meta: PriceMeta) -> Self {
        let overrides = FastOverrides::load();
        let mut entries = FxHashMap::default();
        for (model, r) in &rows {
            let input = r[0].unwrap_or(0.0);
            let fast = r[9].or_else(|| overrides.multiplier_for(model)).unwrap_or(1.0);
            entries.insert(
                model.clone(),
                Pricing {
                    input,
                    output: r[1].unwrap_or(0.0),
                    cache_create: r[2].unwrap_or(input * 1.25),
                    cache_read: r[3].unwrap_or(input * 0.1),
                    cache_read_explicit: r[3].is_some(),
                    input_above: r[4],
                    output_above: r[5],
                    cache_create_above: r[6],
                    cache_read_above: r[7],
                    long_context_threshold: r[8].map(|v| v as u64),
                    fast_multiplier: fast,
                },
            );
        }
        for (model, p) in builtin_entries() {
            entries.entry(model.to_string()).or_insert(Pricing {
                fast_multiplier: overrides.multiplier_for(model).unwrap_or(1.0),
                ..p
            });
        }
        meta.model_count = entries.len();
        Self { entries, compact: rows, meta, cache: RwLock::new(FxHashMap::default()) }
    }

    /// Serialises to the compact snapshot format.
    pub fn to_compact_json(&self) -> String {
        let models: BTreeMap<String, Row> = self
            .compact
            .iter()
            .map(|(k, r)| {
                (k.clone(), Row(r[0].unwrap_or(0.0), r[1].unwrap_or(0.0), r[2], r[3], r[4], r[5], r[6], r[7], r[8].map(|v| v as u64), r[9]))
            })
            .collect();
        serde_json::to_string(&Compact {
            source: self.meta.source.clone(),
            license: "MIT (LiteLLM, © Berri AI)".into(),
            fetched_at: self.meta.fetched_at.clone(),
            models,
        })
        .unwrap_or_default()
    }

    /// Finds pricing for a model name the way ccusage does: exact key,
    /// alias, then the longest boundary-respecting fuzzy key match.
    pub fn find(&self, model: &str) -> Option<Pricing> {
        if let Some(hit) = self.cache.read().ok().and_then(|c| c.get(model).copied()) {
            return hit;
        }
        let result = self
            .entries
            .get(model)
            .copied()
            .or_else(|| alias(model).and_then(|a| self.entries.get(a).copied()))
            .or_else(|| self.fuzzy(alias(model).unwrap_or(model)).or_else(|| self.fuzzy(model)));
        if let Ok(mut c) = self.cache.write() {
            c.insert(model.to_string(), result);
        }
        result
    }

    fn fuzzy(&self, model: &str) -> Option<Pricing> {
        let norm = normalized(model);
        self.entries
            .iter()
            .filter(|(k, _)| key_matches(k, model, &norm))
            .max_by(|(a, _), (b, _)| a.len().cmp(&b.len()).then_with(|| b.cmp(a)))
            .map(|(_, p)| *p)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn alias(model: &str) -> Option<&'static str> {
    match model {
        "gpt-reserve" => Some("gpt-5.6-luna"),
        "gpt-5.6" => Some("gpt-5.6-sol"),
        "gpt-5.3-spark" => Some("gpt-5.3-codex-spark"),
        _ => None,
    }
}

fn normalized(v: &str) -> String {
    v.replace(['.', '@'], "-")
}

fn key_matches(candidate: &str, model: &str, norm_model: &str) -> bool {
    if contains_key(model, candidate) || contains_key(candidate, model) {
        return true;
    }
    let nc = normalized(candidate);
    contains_key(norm_model, &nc) || contains_key(&nc, norm_model)
}

fn contains_key(value: &str, key: &str) -> bool {
    if key.is_empty() {
        return false;
    }
    value.match_indices(key).any(|(i, _)| {
        let before_ok = i == 0 || !value.as_bytes()[i - 1].is_ascii_alphanumeric();
        before_ok && suffix_ok(key, &value[i + key.len()..])
    })
}

fn suffix_ok(key: &str, suffix: &str) -> bool {
    let Some(&sep) = suffix.as_bytes().first() else { return true };
    if sep.is_ascii_alphanumeric() {
        return false;
    }
    // Don't let `gpt-5` match `gpt-5.1-…`, but allow date suffixes (`-20250929`).
    if key.as_bytes().last().is_some_and(u8::is_ascii_digit) && matches!(sep, b'-' | b'.') {
        let rest = &suffix.as_bytes()[1..];
        let n = rest.iter().take_while(|b| b.is_ascii_digit()).count();
        if n > 0 {
            let after = rest.get(n).copied();
            let is_date = n == 8 && after.is_none_or(|b| !b.is_ascii_alphanumeric());
            return is_date;
        }
    }
    true
}

#[derive(Deserialize, Default)]
struct FastOverrides {
    #[serde(default)]
    exact: BTreeMap<String, f64>,
    #[serde(default)]
    normalized_prefix: BTreeMap<String, f64>,
}

impl FastOverrides {
    fn load() -> Self {
        serde_json::from_str(FAST_OVERRIDES).unwrap_or_default()
    }
    fn multiplier_for(&self, model: &str) -> Option<f64> {
        if let Some(v) = self.exact.get(model) {
            return Some(*v);
        }
        let n = normalized(model);
        let tail = n.rsplit('/').next().unwrap_or(&n);
        self.normalized_prefix
            .iter()
            .filter(|(p, _)| tail.starts_with(p.as_str()))
            .max_by_key(|(p, _)| p.len())
            .map(|(_, v)| *v)
    }
}

/// ccusage built-ins, used only when the price list lacks the key.
fn builtin_entries() -> Vec<(&'static str, Pricing)> {
    let p = |input: f64, output: f64, cc: f64, cr: f64| Pricing {
        input,
        output,
        cache_create: cc,
        cache_read: cr,
        cache_read_explicit: true,
        fast_multiplier: 1.0,
        ..Default::default()
    };
    vec![
        ("claude-opus-4-5", p(5e-6, 25e-6, 6.25e-6, 0.5e-6)),
        ("claude-opus-4-6", p(5e-6, 25e-6, 6.25e-6, 0.5e-6)),
        ("claude-opus-4-7", p(5e-6, 25e-6, 6.25e-6, 0.5e-6)),
        ("claude-opus-4-8", p(5e-6, 25e-6, 6.25e-6, 0.5e-6)),
        ("claude-haiku-4-5", p(1e-6, 5e-6, 1.25e-6, 0.1e-6)),
        ("claude-opus-4", p(15e-6, 75e-6, 18.75e-6, 1.5e-6)),
        ("claude-sonnet-4-6", p(3e-6, 15e-6, 3.75e-6, 0.3e-6)),
        ("gpt-5", p(1.25e-6, 10e-6, 1.25e-6, 0.125e-6)),
        ("gpt-5.5", p(5e-6, 30e-6, 5e-6, 0.5e-6)),
        ("gpt-5.4", p(2.5e-6, 15e-6, 2.5e-6, 0.25e-6)),
        ("gpt-5.4-mini", p(0.75e-6, 4.5e-6, 0.75e-6, 0.075e-6)),
    ]
}

fn tiered(tokens: u64, base: f64, above: Option<f64>, threshold: u64) -> f64 {
    if tokens == 0 {
        return 0.0;
    }
    match above {
        Some(a) if tokens > threshold => threshold as f64 * base + (tokens - threshold) as f64 * a,
        _ => tokens as f64 * base,
    }
}

/// Claude-shaped usage for cost calculation.
#[derive(Clone, Copy, Debug, Default)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_create_5m: u64,
    pub cache_create_1h: u64,
    pub cache_read: u64,
}

/// ccusage `calculate_cost_from_pricing` (Claude and Gemini).
pub fn cost_claude_shape(u: Usage, p: &Pricing) -> f64 {
    let cc1h = p.input * CACHE_CREATE_1H_MULTIPLIER;
    let cc1h_above = p.input_above.map(|c| c * CACHE_CREATE_1H_MULTIPLIER);
    if let Some(th) = p.long_context_threshold {
        let ctx = u.input + u.cache_read + u.cache_create_5m + u.cache_create_1h;
        let long = ctx > th;
        let r = |b: f64, a: Option<f64>| if long { a.unwrap_or(b) } else { b };
        return u.input as f64 * r(p.input, p.input_above)
            + u.output as f64 * r(p.output, p.output_above)
            + u.cache_create_5m as f64 * r(p.cache_create, p.cache_create_above)
            + u.cache_create_1h as f64 * r(cc1h, cc1h_above)
            + u.cache_read as f64 * r(p.cache_read, p.cache_read_above);
    }
    let t = DEFAULT_LONG_CONTEXT;
    tiered(u.input, p.input, p.input_above, t)
        + tiered(u.output, p.output, p.output_above, t)
        + tiered(u.cache_create_5m, p.cache_create, p.cache_create_above, t)
        + tiered(u.cache_create_1h, cc1h, cc1h_above, t)
        + tiered(u.cache_read, p.cache_read, p.cache_read_above, t)
}

/// Codex standard-tier cost of one event (ccusage `calculate_codex_bucket_cost`,
/// applied per event so the long-context split is exact).
pub fn cost_codex(input_nc: u64, cached: u64, cache_creation: u64, output: u64, p: &Pricing) -> f64 {
    let cache_read = if p.cache_read_explicit { p.cache_read } else { p.input };
    let cache_creation_rate = p.cache_create;
    let raw_input = input_nc + cached + cache_creation;
    let threshold = p.long_context_threshold.unwrap_or(DEFAULT_LONG_CONTEXT);
    if raw_input > threshold {
        let li = p.input_above.unwrap_or(p.input);
        let lo = p.output_above.unwrap_or(p.output);
        let lcr = if p.cache_read_explicit { p.cache_read_above.unwrap_or(cache_read) } else { li };
        let lcc = p.cache_create_above.unwrap_or(cache_creation_rate);
        input_nc as f64 * li + cached as f64 * lcr + cache_creation as f64 * lcc + output as f64 * lo
    } else {
        input_nc as f64 * p.input
            + cached as f64 * cache_read
            + cache_creation as f64 * cache_creation_rate
            + output as f64 * p.output
    }
}

/// Gemini pricing candidates, in ccusage's order.
pub fn gemini_candidates(model: &str) -> Vec<String> {
    let mut v: Vec<String> = ["google", "gemini", "vertex_ai", "openrouter/google"]
        .iter()
        .map(|p| format!("{p}/{model}"))
        .collect();
    v.push(model.to_string());
    v
}

/// Downloads a fresh price list (the only network call Tokenstreak makes).
#[cfg(feature = "net")]
pub fn fetch_litellm() -> Result<String, String> {
    let agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .build()
        .new_agent();
    let mut resp = agent.get(LITELLM_URL).call().map_err(|e| e.to_string())?;
    resp.body_mut()
        .with_config()
        .limit(32 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_snapshot_has_core_models() {
        let t = PriceTable::embedded();
        for m in ["claude-sonnet-4-5", "claude-opus-4-1", "gpt-5", "gpt-5-codex", "gemini-2.5-pro"] {
            assert!(t.find(m).is_some(), "missing {m}");
        }
    }

    #[test]
    fn fuzzy_respects_versions_and_dates() {
        assert!(contains_key("claude-sonnet-4-5-20250929", "claude-sonnet-4-5"));
        assert!(!contains_key("gpt-5.1-codex", "gpt-5"));
        assert!(contains_key("anthropic/claude-3-opus", "claude-3-opus"));
    }

    #[test]
    fn tiered_matches_ccusage() {
        let p = Pricing { input: 3e-6, input_above: Some(6e-6), ..Default::default() };
        let c = cost_claude_shape(Usage { input: 300_000, ..Default::default() }, &p);
        assert!((c - (200_000.0 * 3e-6 + 100_000.0 * 6e-6)).abs() < 1e-12);
    }
}
