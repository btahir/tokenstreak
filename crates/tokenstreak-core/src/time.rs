//! Timestamp parsing and time-zone-correct day bucketing.

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::Timestamp;

const MS_PER_SECOND: i64 = 1_000;
const MS_PER_MINUTE: i64 = 60 * MS_PER_SECOND;
const MS_PER_HOUR: i64 = 60 * MS_PER_MINUTE;
const MS_PER_DAY: i64 = 24 * MS_PER_HOUR;

/// Parses an RFC 3339 timestamp into epoch milliseconds.
///
/// Mirrors ccusage's strict parser so both tools accept and reject exactly the
/// same lines: `YYYY-MM-DDTHH:MM:SS[.mmm](Z|±HH:MM)`.
pub fn parse_ts(value: &str) -> Option<i64> {
    let b = value.as_bytes();
    let (millis, tz_start) = match b.len() {
        20 | 25 if matches!(b[19], b'Z' | b'+' | b'-') => (0, 19),
        24 | 29 if b[19] == b'.' => (digits(&b[20..23])? as i64, 23),
        _ => return None,
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let year = digits(&b[0..4])? as i32;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let hour = digits(&b[11..13])?;
    let minute = digits(&b[14..16])?;
    let second = digits(&b[17..19])?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let offset_min = parse_offset(&b[tz_start..])?;
    let days = days_from_civil(year, month, day)?;
    let ms = days
        .checked_mul(MS_PER_DAY)?
        .checked_add(hour as i64 * MS_PER_HOUR)?
        .checked_add(minute as i64 * MS_PER_MINUTE)?
        .checked_add(second as i64 * MS_PER_SECOND)?
        .checked_add(millis)?;
    ms.checked_sub(offset_min * MS_PER_MINUTE)
}

fn digits(b: &[u8]) -> Option<u32> {
    let mut v = 0u32;
    for c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as u32;
    }
    Some(v)
}

fn parse_offset(b: &[u8]) -> Option<i64> {
    if b == b"Z" {
        return Some(0);
    }
    if b.len() != 6 || !matches!(b[0], b'+' | b'-') || b[3] != b':' {
        return None;
    }
    let h = digits(&b[1..3])? as i64;
    let m = digits(&b[4..6])? as i64;
    if h > 23 || m > 59 {
        return None;
    }
    let total = h * 60 + m;
    Some(if b[0] == b'-' { -total } else { total })
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if is_leap(y) => 29,
        _ => 28,
    };
    if d > dim {
        return None;
    }
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

/// Formats epoch milliseconds as RFC 3339 with millisecond precision (UTC).
pub fn format_rfc3339_ms(ms: i64) -> String {
    Timestamp::from_millisecond(ms)
        .map(|t| t.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_default()
}

/// The time zone used for day bucketing.
#[derive(Clone, Debug)]
pub struct Clock {
    pub tz: TimeZone,
}

impl Clock {
    /// The system's local time zone (honours `TZ`).
    pub fn system() -> Self {
        Self { tz: TimeZone::system() }
    }

    /// A named IANA zone, falling back to the system zone if unknown.
    pub fn named(name: Option<&str>) -> Self {
        match name.and_then(|n| TimeZone::get(n).ok()) {
            Some(tz) => Self { tz },
            None => Self::system(),
        }
    }

    pub fn utc() -> Self {
        Self { tz: TimeZone::UTC }
    }

    pub fn name(&self) -> String {
        self.tz.iana_name().unwrap_or("local").to_string()
    }

    /// Local calendar date of an instant.
    pub fn date_of(&self, ms: i64) -> Date {
        match Timestamp::from_millisecond(ms) {
            Ok(ts) => ts.to_zoned(self.tz.clone()).date(),
            Err(_) => Date::constant(1970, 1, 1),
        }
    }

    /// Local hour (0..=23) and weekday (0 = Monday) of an instant.
    pub fn hour_and_weekday(&self, ms: i64) -> (u8, u8) {
        match Timestamp::from_millisecond(ms) {
            Ok(ts) => {
                let z = ts.to_zoned(self.tz.clone());
                (z.hour() as u8, z.weekday().to_monday_zero_offset() as u8)
            }
            Err(_) => (0, 3),
        }
    }

    /// Local minutes since midnight (0..1440) of an instant.
    pub fn minute_of_day(&self, ms: i64) -> u16 {
        match Timestamp::from_millisecond(ms) {
            Ok(ts) => {
                let z = ts.to_zoned(self.tz.clone());
                z.hour() as u16 * 60 + z.minute() as u16
            }
            Err(_) => 0,
        }
    }

    /// The instant of local `minute` (minutes since midnight) on `date`
    /// (the first valid instant after a DST gap).
    pub fn instant_at(&self, date: Date, minute: u16) -> Option<i64> {
        let dt = date.at((minute / 60) as i8, (minute % 60) as i8, 0, 0);
        dt.to_zoned(self.tz.clone()).ok().map(|z| z.timestamp().as_millisecond())
    }

    pub fn now_ms(&self) -> i64 {
        Timestamp::now().as_millisecond()
    }

    pub fn today(&self) -> Date {
        self.date_of(self.now_ms())
    }

    /// Milliseconds until the next local midnight (for day-rollover timers).
    pub fn ms_until_next_midnight(&self, now_ms: i64) -> i64 {
        let Ok(ts) = Timestamp::from_millisecond(now_ms) else {
            return MS_PER_HOUR;
        };
        let z = ts.to_zoned(self.tz.clone());
        let tomorrow = z.date().tomorrow().unwrap_or(z.date());
        match tomorrow.to_zoned(self.tz.clone()) {
            Ok(mid) => (mid.timestamp().as_millisecond() - now_ms).max(1_000),
            Err(_) => MS_PER_HOUR,
        }
    }
}

/// Parses `YYYY-MM-DD`.
pub fn parse_date(s: &str) -> Option<Date> {
    s.parse::<Date>().ok()
}

pub fn fmt_date(d: Date) -> String {
    d.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ccusage_formats() {
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_ts("1970-01-01T00:00:01.250Z"), Some(1250));
        assert_eq!(parse_ts("1970-01-01T01:00:00+01:00"), Some(0));
        assert_eq!(parse_ts("1970-01-01T00:00:00.000-05:30"), Some(5 * 3_600_000 + 1_800_000));
        assert_eq!(parse_ts("2026-02-30T00:00:00Z"), None);
        assert_eq!(parse_ts("2026-09-26 10:00:00Z"), None);
        assert_eq!(parse_ts("2026-09-26T10:00:00.123456Z"), None);
        assert_eq!(parse_ts(""), None);
    }

    #[test]
    fn buckets_by_local_day() {
        let ms = parse_ts("2026-03-01T04:30:00Z").unwrap();
        assert_eq!(Clock::utc().date_of(ms).to_string(), "2026-03-01");
        assert_eq!(Clock::named(Some("America/Los_Angeles")).date_of(ms).to_string(), "2026-02-28");
        assert_eq!(Clock::named(Some("Asia/Kolkata")).date_of(ms).to_string(), "2026-03-01");
    }

    #[test]
    fn midnight_countdown_is_positive() {
        let c = Clock::named(Some("Europe/Berlin"));
        let now = parse_ts("2026-03-29T00:30:00Z").unwrap(); // DST day in Berlin
        let ms = c.ms_until_next_midnight(now);
        assert!(ms > 0 && ms <= 24 * MS_PER_HOUR);
    }
}
