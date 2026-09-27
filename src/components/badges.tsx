// Achievement badge art: one round medallion shape for every badge. The
// family picks the palette, the metal picks the rim. Locked badges are
// engraved with CSS (grayscale + progress ring). No achievement ever counts
// money spent.

import { useId, type ReactNode } from "react";
import type { Achievement, AchievementCategory, AchievementTier } from "../api/types";

interface Fam {
  a: string;
  b: string;
  c: string;
  /** motif colour drawn on the medallion */
  ink: string;
}

export const FAMILIES: Record<AchievementCategory, Fam> = {
  consistency: { a: "#FFB27A", b: "#F0728C", c: "#8B6CF0", ink: "#FFF8F0" },
  care: { a: "#CFEBFF", b: "#A9C4F5", c: "#8B7FE0", ink: "#FFFFFF" },
  craft: { a: "#BFE6FF", b: "#86B4F2", c: "#5F5BD6", ink: "#FFFFFF" },
  explorer: { a: "#FFD28A", b: "#F59A5B", c: "#D9577A", ink: "#FFF8F0" },
  scale: { a: "#FFEBB0", b: "#FFC46B", c: "#E0853A", ink: "#6A3210" },
};

/** Metal rims replace fake rarity: bronze, silver, gold, platinum. */
export const METAL_LABEL: Record<AchievementTier, string> = { bronze: "Bronze", silver: "Silver", gold: "Gold", legendary: "Platinum" };
const METAL_RIM: Record<AchievementTier, [string, string, string]> = {
  bronze: ["#F6D2B4", "#D9956A", "#F2C29C"],
  silver: ["#FFFFFF", "#C9CCD8", "#F1F2F7"],
  gold: ["#FFF4C2", "#FFC46B", "#FFE9A8"],
  legendary: ["#FFFFFF", "#D8E6FF", "#FFE3F0"],
};
export const CATEGORY_LABEL: Record<AchievementCategory, string> = {
  consistency: "Consistency",
  care: "Care",
  craft: "Craft",
  explorer: "Explorer",
  scale: "Scale",
};

function star4(x: number, y: number, r: number, f: string, key?: string | number): ReactNode {
  const k = r * 0.14;
  return <path key={key} d={`M${x} ${y - r}Q${x + k} ${y - k} ${x + r} ${y}Q${x + k} ${y + k} ${x} ${y + r}Q${x - k} ${y + k} ${x - r} ${y}Q${x - k} ${y - k} ${x} ${y - r}Z`} fill={f} />;
}

const SHAPE = <circle cx="48" cy="48" r="42" />;
const serif = { fontFamily: "'Instrument Serif', Georgia, serif" } as const;

function art(id: string, u: string, W: string): ReactNode {
  switch (id) {
    case "first-light":
      return (
        <>
          <circle cx="48" cy="50" r="18" fill={`url(#glow${u})`} />
          {star4(48, 50, 14, W)}
          <path d="M22 70c9-3 15-8 23-16" stroke={W} strokeWidth="2.5" strokeLinecap="round" fill="none" opacity=".7" />
        </>
      );
    case "seven-sparks": {
      const s: ReactNode[] = [];
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (0.15 + (i / 6) * 0.7);
        s.push(star4(48 - Math.cos(a) * 26, 60 - Math.sin(a) * 26, i === 6 ? 7 : 4.5, W, i));
      }
      return (
        <>
          {s}
          <text x="48" y="67" textAnchor="middle" fontSize="27" fill={W} style={serif}>
            7
          </text>
        </>
      );
    }
    case "full-moon":
      return (
        <>
          <circle cx="48" cy="46" r="21" fill="#FFF3E0" />
          <circle cx="41" cy="40" r="4" fill="#F5D9C0" />
          <circle cx="55" cy="52" r="6" fill="#F5D9C0" />
          <circle cx="52" cy="36" r="2.5" fill="#F5D9C0" />
          <circle cx="48" cy="46" r="27" fill="none" stroke="#FFF3E0" strokeOpacity=".35" strokeWidth="1.5" />
        </>
      );
    case "aurora":
      return (
        <>
          <path d="M14 58c10-22 18-30 34-30s24 10 34 26" stroke="#B8F2DC" strokeWidth="7" strokeLinecap="round" fill="none" opacity=".75" />
          <path d="M16 66c10-16 20-24 32-24s22 8 32 22" stroke="#D6C8FF" strokeWidth="6" strokeLinecap="round" fill="none" opacity=".85" />
          <path d="M18 74c10-10 20-16 30-16s20 6 30 16" stroke="#FFD0DA" strokeWidth="5" strokeLinecap="round" fill="none" opacity=".9" />
          {star4(64, 24, 5, W)}
          {star4(30, 28, 3.5, W)}
        </>
      );
    case "halo":
      return (
        <>
          <ellipse cx="48" cy="32" rx="22" ry="7" fill="none" stroke={W} strokeWidth="3" />
          {star4(48, 56, 15, W)}
          <circle cx="48" cy="56" r="22" fill={`url(#glow${u})`} opacity=".6" />
        </>
      );
    case "steady-hand": {
      const s: ReactNode[] = [];
      for (let w = 0; w < 4; w++)
        for (let d = 0; d < 5; d++) s.push(<circle key={`${w}${d}`} cx={27 + w * 14} cy={30 + d * 9} r="3" fill={W} opacity={0.55 + w * 0.15} />);
      return <>{s}</>;
    }
    case "high-tide":
      return (
        <>
          <path d="M14 58c6-6 12-6 17 0s11 6 17 0 11-6 17 0 11 6 17 0" stroke={W} strokeWidth="3.2" fill="none" strokeLinecap="round" />
          <path d="M14 70c6-6 12-6 17 0s11 6 17 0 11-6 17 0 11 6 17 0" stroke={W} strokeWidth="2.4" fill="none" strokeLinecap="round" opacity=".6" />
          <circle cx="48" cy="34" r="9" fill="#FFF3E0" />
        </>
      );
    case "rekindled":
      return (
        <>
          <path d="M48 20c4 10 16 16 16 30a16 16 0 0 1-32 0c0-8 4-12 8-16 0 6 2 9 5 10-2-8 0-16 3-24Z" fill={W} />
          <path d="M48 48c3 4 7 6 7 11a7 7 0 0 1-14 0c0-4 3-7 7-11Z" fill="#F0728C" />
        </>
      );
    case "safety-net":
      return (
        <>
          <path d="M20 40c8 18 48 18 56 0" stroke={W} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <path d="M26 44l8 14M38 48l2 14M48 49v14M58 48l-2 14M70 44l-8 14M28 56c10 8 30 8 40 0" stroke={W} strokeWidth="1.6" fill="none" strokeLinecap="round" opacity=".75" />
          {star4(48, 30, 8, W)}
        </>
      );
    case "deep-memory":
      return (
        <>
          <circle cx="48" cy="48" r="7" fill={W} />
          <circle cx="48" cy="48" r="15" fill="none" stroke={W} strokeWidth="2.5" opacity=".85" />
          <circle cx="48" cy="48" r="23" fill="none" stroke={W} strokeWidth="2" opacity=".55" />
          <circle cx="48" cy="48" r="31" fill="none" stroke={W} strokeWidth="1.5" opacity=".3" />
        </>
      );
    case "echo":
      return (
        <>
          <circle cx="30" cy="48" r="6" fill={W} />
          <path d="M42 34a18 18 0 0 1 0 28M52 26a28 28 0 0 1 0 44M62 18a38 38 0 0 1 0 60" stroke={W} strokeWidth="2.6" fill="none" strokeLinecap="round" />
        </>
      );
    case "featherweight":
      return (
        <>
          <path d="M66 20C44 22 30 38 28 66c14-2 30-12 38-46Z" fill={W} opacity=".95" />
          <path d="M24 74 58 30" stroke={FAMILIES.craft.c} strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    case "trio":
      return (
        <>
          <circle cx="38" cy="42" r="13" fill="#FFF3E6" opacity=".95" />
          <rect x="45" y="30" width="24" height="24" rx="6" fill="#FFE1EA" opacity=".92" />
          <path d="M48 50 60 72H36Z" fill="#E8E0FF" opacity=".95" strokeLinejoin="round" />
        </>
      );
    case "megawatt":
      return (
        <>
          <path d="M53 16 30 52h15l-5 28 26-40H50Z" fill={W} strokeLinejoin="round" />
          {star4(70, 28, 5, "#FFFFFF")}
        </>
      );
    case "constellation": {
      const p: [number, number][] = [[26, 60], [37, 38], [52, 45], [62, 28], [71, 55], [52, 66]];
      return (
        <>
          <path d={`M${p.map((q) => q.join(" ")).join("L")}`} stroke={W} strokeWidth="1.5" fill="none" opacity=".6" />
          {p.map((q, i) => star4(q[0], q[1], i === 3 ? 6.5 : 4, "#FFFFFF", i))}
        </>
      );
    }
    case "galaxy":
      return (
        <>
          <ellipse cx="48" cy="48" rx="31" ry="11" fill="none" stroke="#FFFFFF" strokeWidth="1.8" opacity=".85" transform="rotate(-20 48 48)" />
          <ellipse cx="48" cy="48" rx="20" ry="6.5" fill="none" stroke="#FFFFFF" strokeWidth="1.4" opacity=".6" transform="rotate(-20 48 48)" />
          <circle cx="48" cy="48" r="9" fill={`url(#glow${u})`} />
          {star4(48, 48, 8, "#FFFFFF")}
          {star4(72, 30, 3.5, "#FFFFFF")}
          {star4(26, 64, 2.8, "#FFFFFF")}
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
  const f = FAMILIES[a.category] ?? FAMILIES.consistency;
  const rim = METAL_RIM[a.tier] ?? METAL_RIM.bronze;
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
          <stop offset="0" stopColor={rim[0]} />
          <stop offset=".5" stopColor={rim[1]} />
          <stop offset="1" stopColor={rim[2]} />
        </linearGradient>
        <clipPath id={`clip${u}`}>{SHAPE}</clipPath>
      </defs>
      <g fill={`url(#bg${u})`} stroke={`url(#rim${u})`} strokeWidth={a.tier === "legendary" ? 4 : 3.2}>
        {SHAPE}
      </g>
      <g clipPath={`url(#clip${u})`}>
        <rect width="96" height="48" fill={`url(#sheen${u})`} />
        <circle cx="48" cy="48" r="36" fill="none" stroke="#FFFFFF" strokeOpacity=".22" strokeWidth="1" />
        {art(a.id, u, f.ink)}
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
    <div
      className={`badge${locked ? " badge--locked" : ""}${a.isNew ? " badge--new" : ""}`}
      data-testid={`badge-${a.id}`}
      title={a.description}
      tabIndex={0}
      role="group"
      aria-label={`${a.title}${locked ? ", locked" : ", unlocked"}. ${a.description}`}
    >
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
      {!compact && (
        <span className="badge__family">
          {CATEGORY_LABEL[a.category]} · {METAL_LABEL[a.tier]}
        </span>
      )}
    </div>
  );
}
