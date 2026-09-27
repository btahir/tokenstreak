// Inline SVG icons and brand marks. Stroke icons inherit currentColor.

import { useId, type SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

const base = (size: number, rest: SVGProps<SVGSVGElement>) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...rest,
});

export const IconRefresh = ({ size = 15, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
  </svg>
);
export const IconWindow = ({ size = 15, ...r }: P) => (
  <svg {...base(size, r)}>
    <rect x="2" y="2.5" width="12" height="11" rx="2.5" />
    <path d="M2 6h12" />
  </svg>
);
export const IconGear = ({ size = 15, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" />
  </svg>
);
export const IconTrail = ({ size = 16, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <path d="M1.5 12.5c3-.5 4.5-2.5 6-5s3-3.8 5-3.8" />
    <circle cx="13" cy="3.6" r="1.8" fill="currentColor" stroke="none" />
  </svg>
);
export const IconBars = ({ size = 16, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <path d="M3 13V8M8 13V3M13 13V6" />
  </svg>
);
export const IconMedal = ({ size = 16, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <circle cx="8" cy="6.5" r="4.5" />
    <path d="M5.5 10.3 4.5 15l3.5-2 3.5 2-1-4.7" />
  </svg>
);
export const IconShare = ({ size = 14, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M8 10V2M5 5l3-3 3 3M3 9v4h10V9" />
  </svg>
);
export const IconLock = ({ size = 14, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <rect x="3" y="7" width="10" height="7" rx="2" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);
export const IconCheck = ({ size = 12, ...r }: P) => (
  <svg {...base(size, { viewBox: "0 0 10 10", ...r })}>
    <path d="M2 5.2 4.2 7.4 8 3" />
  </svg>
);
export const IconClose = ({ size = 14, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
export const IconCopy = ({ size = 14, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <rect x="5" y="5" width="8.5" height="8.5" rx="2" />
    <path d="M10.5 5V3.8A1.8 1.8 0 0 0 8.7 2H3.8A1.8 1.8 0 0 0 2 3.8v4.9a1.8 1.8 0 0 0 1.8 1.8H5" />
  </svg>
);
export const IconDownload = ({ size = 14, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M8 2v8M5 7l3 3 3-3M3 12.5h10" />
  </svg>
);
export const IconPlay = ({ size = 10, ...r }: P) => (
  <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden {...r}>
    <path d="M2.5 1.5v7l6-3.5z" fill="currentColor" />
  </svg>
);
export const IconArrow = ({ size = 12, dir = "up", ...r }: P & { dir?: "up" | "down" }) => (
  <svg {...base(size, { viewBox: "0 0 12 12", strokeWidth: 1.6, ...r })} style={{ transform: dir === "down" ? "rotate(180deg)" : undefined }}>
    <path d="M6 10V2.5M2.8 5.5 6 2.3l3.2 3.2" />
  </svg>
);
export const IconHeart = ({ size = 14, ...r }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...r}>
    <path d="M8 14s-5.5-3.4-5.5-7.2A3 3 0 0 1 8 5a3 3 0 0 1 5.5 1.8C13.5 10.6 8 14 8 14Z" fill="#F0728C" />
  </svg>
);
export const IconExternal = ({ size = 12, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.5, ...r })}>
    <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />
  </svg>
);
export const IconFolder = ({ size = 14, ...r }: P) => (
  <svg {...base(size, { strokeWidth: 1.4, ...r })}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </svg>
);

/** The four-point spark: our streak "flame". */
export function Spark({ size = 14, from = "#FFB27A", to = "#F0728C", ...r }: P & { from?: string; to?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden {...r}>
      <defs>
        <linearGradient id={`sk${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <path d="M10 1Q11.4 8.6 19 10Q11.4 11.4 10 19Q8.6 11.4 1 10Q8.6 8.6 10 1Z" fill={`url(#sk${id})`} />
    </svg>
  );
}

/** Logo mark: a swooping trail ending in a spark. */
export function LogoMark({ size = 20 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={`lm${id}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#8B6CF0" />
          <stop offset=".55" stopColor="#F0728C" />
          <stop offset="1" stopColor="#FFB27A" />
        </linearGradient>
      </defs>
      <path d="M3 25c6-1 9-5 12-10s6-8 10-8" stroke={`url(#lm${id})`} strokeWidth="3.6" strokeLinecap="round" fill="none" />
      <circle cx="25" cy="7" r="4.6" fill="#FFF3E0" />
      <circle cx="25" cy="7" r="4.6" fill="none" stroke="#FFB27A" strokeWidth="1.4" />
    </svg>
  );
}

export function Wordmark({ size = 19, mark = 20 }: { size?: number; mark?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      <LogoMark size={mark} />
      Tokenstreak
    </span>
  );
}
