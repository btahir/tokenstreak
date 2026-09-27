// Achievement badge art: one SVG medallion per achievement. The category picks
// the medallion shape and palette; the tier adds a rim (gold rim for
// legendary). Locked badges are engraved with CSS (grayscale + progress ring).
// No achievement ever counts money spent.

import { useId, type ReactNode } from "react";
import type { Achievement, AchievementCategory, AchievementTier } from "../api/types";

interface Fam {
  a: string;
  b: string;
  c: string;
  rim: string;
}

export const FAMILIES: Record<AchievementCategory, Fam> = {
  streak: { a: "#FFB27A", b: "#F0728C", c: "#8B6CF0", rim: "#FFE3C8" },
  goals: { a: "#FFD6DE", b: "#F0728C", c: "#B85FC0", rim: "#FFE8EE" },
  volume: { a: "#FFE9A8", b: "#FFC46B", c: "#E8883A", rim: "#FFF4D6" },
  explorer: { a: "#FFD28A", b: "#F59A5B", c: "#EC5F80", rim: "#FFEBD1" },
  habits: { a: "#C9C2FF", b: "#9A86F2", c: "#4F3FA8", rim: "#ECE8FF" },
  efficiency: { a: "#BFE6FF", b: "#8FB8F5", c: "#6E6AE0", rim: "#E6F4FF" },
};

export const TIER_LABEL: Record<AchievementTier, string> = { bronze: "Common", silver: "Rare", gold: "Epic", legendary: "Legendary" };
export const TIER_CLASS: Record<AchievementTier, string> = { bronze: "common", silver: "rare", gold: "epic", legendary: "legendary" };
export const CATEGORY_LABEL: Record<AchievementCategory, string> = {
  streak: "Streak",
  goals: "Goals",
  volume: "Volume",
  explorer: "Explorer",
  habits: "Habits",
  efficiency: "Efficiency",
};

const W = "#FFF8F0";
const INK = "#7A3A12";

function star4(x: number, y: number, r: number, f: string, key?: string | number): ReactNode {
  const k = r * 0.14;
  return <path key={key} d={`M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`} fill={f} />;
}

function shape(cat: AchievementCategory): ReactNode {
  switch (cat) {
    case "streak":
      return <circle cx="48" cy="48" r="42" />;
    case "efficiency":
      return <path d="M48 5.5 84.8 26.8v42.4L48 90.5 11.2 69.2V26.8Z" strokeLinejoin="round" />;
    case "explorer":
      return <path d="M48 6c30 0 42 12 42 42s-12 42-42 42S6 78 6 48 18 6 48 6Z" />;
    case "habits":
      return <path d="M48 5c6 0 10 4 16 10l17 17c6 6 10 10 10 16s-4 10-10 16L64 81c-6 6-10 10-16 10s-10-4-16-10L15 64C9 58 5 54 5 48s4-10 10-16l17-17C38 9 42 5 48 5Z" />;
    case "goals":
      return <path d="M48 6 82 18v26c0 22-14 38-34 46C28 82 14 66 14 44V18Z" strokeLinejoin="round" />;
    case "volume": {
      let d = "";
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 ? 37 : 44;
        d += `${i ? "L" : "M"}${(48 + Math.cos(a) * r).toFixed(1)} ${(48 + Math.sin(a) * r).toFixed(1)}`;
      }
      return <path d={`${d}Z`} strokeLinejoin="round" />;
    }
  }
}

const serif = { fontFamily: "'Instrument Serif', Georgia, serif" } as const;
const sans = { fontFamily: "'Geist Variable', Geist, system-ui", fontWeight: 700 } as const;

function art(id: string, u: string): ReactNode {
  switch (id) {
    case "first-spark":
      return (
        <>
          <circle cx="48" cy="52" r="16" fill={`url(#glow${u})`} />
          {star4(48, 52, 13, W)}
          <path d="M24 68c8-3 14-8 22-15" stroke={W} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity=".7" />
        </>
      );
    case "goal-getter":
      return (
        <>
          <circle cx="48" cy="50" r="22" fill="none" stroke={W} strokeWidth="2.4" opacity=".55" />
          <circle cx="48" cy="50" r="13" fill="none" stroke={W} strokeWidth="2.4" opacity=".8" />
          {star4(48, 50, 8, W)}
        </>
      );
    case "streak-3":
    case "streak-7": {
      const n = id === "streak-3" ? 3 : 7;
      const s: ReactNode[] = [];
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (n === 3 ? 0.3 + (i / 2) * 0.4 : 0.15 + (i / 6) * 0.7);
        s.push(star4(48 - Math.cos(a) * 26, 60 - Math.sin(a) * 26, i === n - 1 ? 7 : 4.5, W, i));
      }
      return (
        <>
          {s}
          <text x="48" y="67" textAnchor="middle" fontSize="27" fill={W} style={serif}>
            {n}
          </text>
        </>
      );
    }
    case "streak-30":
      return (
        <>
          <circle cx="48" cy="46" r="21" fill="#FFF3E0" />
          <circle cx="41" cy="40" r="4" fill="#F5D9C0" />
          <circle cx="55" cy="52" r="6" fill="#F5D9C0" />
          <circle cx="52" cy="36" r="2.5" fill="#F5D9C0" />
          <circle cx="48" cy="46" r="27" fill="none" stroke="#FFF3E0" strokeOpacity=".35" strokeWidth="1.5" />
          <text x="48" y="84" textAnchor="middle" fontSize="8" letterSpacing="1" fill={W} opacity=".9" style={sans}>
            30
          </text>
        </>
      );
    case "streak-100":
      return (
        <>
          <path d="M14 58c10-22 18-30 34-30s24 10 34 26" stroke="#9FF0D0" strokeWidth="7" strokeLinecap="round" fill="none" opacity=".75" />
          <path d="M16 66c10-16 20-24 32-24s22 8 32 22" stroke="#C9B6FF" strokeWidth="6" strokeLinecap="round" fill="none" opacity=".8" />
          <path d="M18 74c10-10 20-16 30-16s20 6 30 16" stroke="#FFC2D0" strokeWidth="5" strokeLinecap="round" fill="none" opacity=".85" />
          {star4(64, 24, 5, W)}
          {star4(30, 28, 3.5, W)}
          <text x="48" y="86" textAnchor="middle" fontSize="7.5" letterSpacing="1" fill={W} style={sans}>
            100
          </text>
        </>
      );
    case "comeback":
      return (
        <>
          <path d="M48 22c4 10 16 16 16 30a16 16 0 0 1-32 0c0-8 4-12 8-16 0 6 2 9 5 10-2-8 0-16 3-24Z" fill={W} />
          <path d="M48 50c3 4 7 6 7 11a7 7 0 0 1-14 0c0-4 3-7 7-11Z" fill="#F0728C" />
        </>
      );
    case "overachiever":
      return (
        <>
          <text x="46" y="62" textAnchor="middle" fontSize="36" fill={W} style={serif}>
            2×
          </text>
          {star4(68, 30, 6, W)}
        </>
      );
    case "weekly-goal": {
      const s: ReactNode[] = [];
      [14, 22, 30, 22, 30, 22, 30].forEach((h, i) =>
        s.push(<rect key={i} x={22 + i * 8} y={62 - h} width="5" height={h} rx="2.5" fill={W} opacity={i === 0 ? 0.5 : 0.95} />),
      );
      return (
        <>
          {s}
          <path d="M20 70h56" stroke={W} strokeWidth="2" strokeLinecap="round" opacity=".5" />
        </>
      );
    }
    case "weekend-warrior":
      return (
        <>
          <path d="M18 64c10-6 20-8 30-8s20 2 30 8" stroke={W} strokeWidth="2" fill="none" strokeLinecap="round" opacity=".55" />
          <text x="36" y="52" textAnchor="middle" fontSize="24" fill={W} style={serif}>
            S
          </text>
          <text x="60" y="52" textAnchor="middle" fontSize="24" fill={W} style={serif}>
            S
          </text>
          {star4(48, 26, 5, W)}
        </>
      );
    case "day-1m":
    case "day-10m":
    case "day-100m": {
      const label = id === "day-1m" ? "1M" : id === "day-10m" ? "10M" : "100M";
      return (
        <>
          <text x="48" y={label.length > 3 ? 57 : 60} textAnchor="middle" fontSize={label.length > 3 ? 23 : label.length > 2 ? 28 : 34} fill={INK} style={serif}>
            {label}
          </text>
          {star4(70, 29, 6, "#FFFFFF")}
        </>
      );
    }
    case "lifetime-100m": {
      const p: [number, number][] = [[28, 60], [38, 40], [52, 46], [62, 30], [70, 56], [52, 66]];
      return (
        <>
          <path d={`M${p.map((q) => q.join(" ")).join("L")}`} stroke={INK} strokeWidth="1.5" fill="none" opacity=".6" />
          {p.map((q, i) => star4(q[0], q[1], i === 3 ? 6.5 : 4, "#FFFFFF", i))}
        </>
      );
    }
    case "lifetime-1b":
      return (
        <>
          <ellipse cx="48" cy="50" rx="30" ry="11" fill="none" stroke="#FFFFFF" strokeWidth="1.8" opacity=".8" transform="rotate(-18 48 50)" />
          <text x="48" y="60" textAnchor="middle" fontSize="30" fill={INK} style={serif}>
            1B
          </text>
          {star4(72, 36, 4.5, "#FFFFFF")}
        </>
      );
    case "lifetime-10b":
      return (
        <>
          <circle cx="48" cy="46" r="24" fill="none" stroke="#FFF4D6" strokeWidth="3.5" />
          <circle cx="48" cy="46" r="30" fill="none" stroke="#FFF4D6" strokeWidth="1" strokeDasharray="1 5" strokeLinecap="round" />
          {star4(48, 46, 14, "#FFFFFF")}
          <text x="48" y="86" textAnchor="middle" fontSize="7.5" letterSpacing="1" fill={INK} style={sans}>
            10B
          </text>
        </>
      );
    case "marathon":
      return (
        <>
          <path d="M20 70c10 0 14-8 20-14s12-6 16-12 2-12 10-16" stroke={W} strokeWidth="3" fill="none" strokeLinecap="round" strokeDasharray="0.1 6" />
          <circle cx="20" cy="70" r="4" fill={W} />
          <path d="M66 28V14l10 4-10 4" fill={W} stroke={W} strokeWidth="1.5" strokeLinejoin="round" />
        </>
      );
    case "polyglot":
      return (
        <>
          <circle cx="38" cy="48" r="14" fill="#FFF3E6" opacity=".95" />
          <rect x="46" y="34" width="26" height="26" rx="7" fill="#FFE1EA" opacity=".9" />
        </>
      );
    case "full-house":
      return (
        <>
          <circle cx="38" cy="42" r="13" fill="#FFF3E6" opacity=".95" />
          <rect x="45" y="30" width="24" height="24" rx="6" fill="#FFE1EA" opacity=".9" />
          <path d="M48 50 60 72H36Z" fill="#E8E0FF" opacity=".92" strokeLinejoin="round" />
        </>
      );
    case "model-collector": {
      const s: ReactNode[] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        s.push(<circle key={i} cx={48 + Math.cos(a) * 20} cy={49 + Math.sin(a) * 20} r={i === 0 ? 6 : 4.5} fill={W} opacity={i === 0 ? 1 : 0.85} />);
      }
      return (
        <>
          <circle cx="48" cy="49" r="20" fill="none" stroke={W} strokeWidth="1.4" opacity=".45" />
          {s}
        </>
      );
    }
    case "project-hopper":
      return (
        <>
          <rect x="20" y="56" width="16" height="12" rx="3" fill={W} opacity=".6" />
          <rect x="40" y="44" width="16" height="12" rx="3" fill={W} opacity=".8" />
          <rect x="60" y="32" width="16" height="12" rx="3" fill={W} />
          <path d="M28 52c2-6 6-9 12-10M48 40c2-6 6-9 12-10" stroke={W} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeDasharray="0.1 4" />
        </>
      );
    case "night-owl":
      return (
        <>
          <path d="M56 26a22 22 0 1 0 12 38 18 18 0 1 1-12-38Z" fill="#FFF3E0" />
          {star4(64, 34, 4, W)}
          {star4(72, 50, 2.6, W)}
          {star4(30, 28, 2.6, W)}
        </>
      );
    case "early-bird":
      return (
        <>
          <path d="M22 62a26 26 0 0 1 52 0Z" fill="#FFF3E0" />
          {[0, 1, 2, 3, 4].map((i) => {
            const a = Math.PI * (1 + (i + 0.5) / 5);
            return <path key={i} d={`M${48 + Math.cos(a) * 31} ${62 + Math.sin(a) * 31}L${48 + Math.cos(a) * 38} ${62 + Math.sin(a) * 38}`} stroke="#FFF3E0" strokeWidth="2.6" strokeLinecap="round" />;
          })}
          <path d="M16 68h64" stroke={W} strokeWidth="2.2" strokeLinecap="round" opacity=".7" />
        </>
      );
    case "cache-master":
      return (
        <>
          <circle cx="48" cy="48" r="7" fill={W} />
          <circle cx="48" cy="48" r="15" fill="none" stroke={W} strokeWidth="2.5" opacity=".85" />
          <circle cx="48" cy="48" r="23" fill="none" stroke={W} strokeWidth="2" opacity=".55" />
          <circle cx="48" cy="48" r="31" fill="none" stroke={W} strokeWidth="1.5" opacity=".3" />
        </>
      );
    default:
      return (
        <>
          <circle cx="48" cy="48" r="16" fill={`url(#glow${u})`} />
          {star4(48, 48, 14, W)}
        </>
      );
  }
}

export function BadgeArt({ a, size = 96 }: { a: Pick<Achievement, "id" | "title" | "category" | "tier">; size?: number }) {
  const u = useId().replace(/:/g, "");
  const f = FAMILIES[a.category] ?? FAMILIES.streak;
  const legendary = a.tier === "legendary";
  return (
    <svg className="badge-svg" width={size} height={size} viewBox="0 0 96 96" role="img" aria-label={a.title}>
      <defs>
        <linearGradient id={`bg${u}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={f.a} />
          <stop offset=".55" stopColor={f.b} />
          <stop offset="1" stopColor={f.c} />
        </linearGradient>
        <radialGradient id={`glow${u}`}>
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`sheen${u}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".45" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`rim${u}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFF4C2" />
          <stop offset=".5" stopColor="#FFC46B" />
          <stop offset="1" stopColor="#FFE9A8" />
        </linearGradient>
        <clipPath id={`clip${u}`}>{shape(a.category)}</clipPath>
      </defs>
      <g fill={`url(#bg${u})`} stroke={legendary ? `url(#rim${u})` : f.rim} strokeWidth={legendary ? 3.5 : 2.5}>
        {shape(a.category)}
      </g>
      <g clipPath={`url(#clip${u})`}>
        <rect width="96" height="48" fill={`url(#sheen${u})`} />
        {art(a.id, u)}
        <rect className="badge-shine" x="-60" y="-10" width="30" height="120" fill="#fff" opacity="0" transform="rotate(20)" />
      </g>
    </svg>
  );
}

/** A badge with name, meta line and (when locked) a progress ring. */
export function Badge({ a, size = 92, meta, compact }: { a: Achievement; size?: number; meta?: ReactNode; compact?: boolean }) {
  const locked = !a.unlockedAt;
  const p = a.target > 0 ? Math.max(0, Math.min(1, a.progress / a.target)) : 0;
  const ring = size + 12;
  const r = ring / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <div className={`badge${locked ? " badge--locked" : ""}${a.isNew ? " badge--new" : ""}`} data-testid={`badge-${a.id}`} title={a.description}>
      <div className="badge__art">
        <BadgeArt a={a} size={size} />
        {locked && p > 0 && (
          <svg className="badge__progress" width={ring} height={ring} viewBox={`0 0 ${ring} ${ring}`} aria-hidden>
            <circle cx={ring / 2} cy={ring / 2} r={r} fill="none" stroke="var(--line)" strokeWidth="3" />
            <circle cx={ring / 2} cy={ring / 2} r={r} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} transform={`rotate(-90 ${ring / 2} ${ring / 2})`} />
          </svg>
        )}
        {a.isNew && <span className="badge__new">New</span>}
      </div>
      <div className="badge__name">{a.title}</div>
      {meta && <div className="badge__meta">{meta}</div>}
      {!compact && <span className={`rarity rarity--${TIER_CLASS[a.tier]}`}>{TIER_LABEL[a.tier]}</span>}
    </div>
  );
}
