import type { Verdict } from "./reflex.js";
import { SIGNALS } from "./questions.js";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: esc("1"),
  dim: esc("2"),
  red: esc("31"),
  green: esc("32"),
  yellow: esc("33"),
  cyan: esc("36"),
  gray: esc("90"),
  bgRed: esc("41;97;1"),
  bgGreen: esc("42;30;1"),
  bgYellow: esc("43;30;1"),
  bgGray: esc("100;97;1"),
};

export function badge(decision: Verdict["decision"]): string {
  switch (decision) {
    case "allow":
      return c.bgGreen(" ALLOW ");
    case "ask":
      return c.bgYellow("  ASK  ");
    case "deny":
      return c.bgRed(" DENY  ");
    default:
      return c.bgGray(" DEFER ");
  }
}

const bar = (p: number, width = 12) => {
  const filled = Math.round(Math.max(0, Math.min(1, p)) * width);
  const paint = p >= 0.6 ? c.red : p >= 0.3 ? c.yellow : c.green;
  return paint("█".repeat(filled)) + c.gray("░".repeat(width - filled));
};

export function renderVerdict(summary: string, v: Verdict, opts: { explain?: boolean; width?: number } = {}): string {
  const width = opts.width ?? Math.min(process.stdout.columns || 100, 110);
  const meta = v.source === "jev" ? `${v.latencyMs}ms · jev` : v.source === "rule" ? `${v.latencyMs}ms · rule` : "fallback";
  const room = Math.max(20, width - 10 - meta.length - 3);
  const shown = summary.length > room ? summary.slice(0, room - 1) + "…" : summary;
  const lines = [`${badge(v.decision)} ${c.bold(shown)}${" ".repeat(Math.max(1, room - shown.length + 1))}${c.gray(meta)}`];
  lines.push(`        ${c.dim(v.reason)}`);
  if (opts.explain && v.source === "jev" && v.signals) {
    lines.push(`        ${c.gray("risk".padEnd(40))}${bar((v.risk ?? 0) / 4)} ${(v.risk ?? 0).toFixed(1)}/4 ${c.gray(`conf ${Math.round((v.riskConfidence ?? 0) * 100)}%`)}`);
    lines.push(`        ${c.gray("category".padEnd(40))}${c.cyan(v.category ?? "")} ${c.gray(`${Math.round((v.categoryConfidence ?? 0) * 100)}%`)}`);
    for (const [name, p] of Object.entries(v.signals)) {
      const label = SIGNALS[name as keyof typeof SIGNALS]?.label ?? name;
      lines.push(`        ${c.gray(label.padEnd(40))}${bar(p)} ${String(Math.round(p * 100)).padStart(3)}%`);
    }
    if (v.onTask !== undefined) lines.push(`        ${c.gray("off-task vs. the user's request".padEnd(40))}${bar(1 - v.onTask)} ${String(Math.round((1 - v.onTask) * 100)).padStart(3)}%`);
  }
  return lines.join("\n");
}
