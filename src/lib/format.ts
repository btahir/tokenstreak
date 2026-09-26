// Number and date formatting shared by views.

export function formatTokens(n: number, digits = 1): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : digits)}K`;
  return String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n >= 100 ? 0 : 2 });
}

export function formatPercent(r: number, digits = 0): string {
  return `${(r * 100).toFixed(digits)}%`;
}

export const TOOL_NAMES = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" } as const;
