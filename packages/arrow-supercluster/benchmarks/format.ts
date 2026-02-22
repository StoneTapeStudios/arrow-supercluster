/**
 * CLI formatting utilities for benchmark output.
 */

// ─── ANSI Colors ────────────────────────────────────────────────────────────

export const Colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
} as const;

export function colorize(text: string, color: string): string {
  return `${color}${text}${Colors.reset}`;
}

// ─── Number Formatting ──────────────────────────────────────────────────────

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function fmtDelta(speedup: number): string {
  if (speedup >= 1) {
    return colorize(`${speedup.toFixed(2)}×  faster`, Colors.green);
  }
  return colorize(`${(1 / speedup).toFixed(2)}×  slower`, Colors.red);
}

// ─── Visual Elements ────────────────────────────────────────────────────────

const BOX_WIDTH = 78;

export function header(title: string): void {
  const pad = Math.max(0, BOX_WIDTH - title.length - 4);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(colorize(`  ╔${"═".repeat(BOX_WIDTH)}╗`, Colors.cyan));
  console.log(
    colorize(
      `  ║${" ".repeat(left + 1)}${title}${" ".repeat(right + 1)}║`,
      Colors.cyan,
    ),
  );
  console.log(colorize(`  ╚${"═".repeat(BOX_WIDTH)}╝`, Colors.cyan));
}

export function divider(): void {
  console.log(colorize(`  ${"─".repeat(BOX_WIDTH)}`, Colors.dim));
}

export function sectionTitle(num: string, title: string): void {
  console.log(colorize(`  ┌─ ${num}. ${title}`, Colors.cyan));
}

export function row(label: string, value: string): void {
  const gap = Math.max(1, 40 - label.length);
  console.log(`  │ ${label}${" ".repeat(gap)}${value}`);
}

export function sparkBar(filled: number, total: number): string {
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, total - filled));
  return colorize(bar, Colors.green);
}

// ─── Table Formatting ───────────────────────────────────────────────────────

const COL_WIDTHS = [12, 14, 14, 18, 10, 22];

function padCell(text: string, width: number): string {
  // Strip ANSI codes for length calculation
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - stripped.length);
  return text + " ".repeat(pad);
}

export function tableHeader(cols: string[]): void {
  const cells = cols.map((c, i) =>
    colorize(padCell(c, COL_WIDTHS[i] ?? 14), Colors.dim),
  );
  console.log(`  │ ${cells.join("│ ")}`);
  const line = cols.map((_, i) => "─".repeat(COL_WIDTHS[i] ?? 14)).join("┼─");
  console.log(colorize(`  │ ${line}`, Colors.dim));
}

export function tableRow(cols: string[]): void {
  const cells = cols.map((c, i) => padCell(c, COL_WIDTHS[i] ?? 14));
  console.log(`  │ ${cells.join("│ ")}`);
}

export function tableDivider(): void {
  console.log(colorize(`  └${"─".repeat(BOX_WIDTH - 1)}`, Colors.dim));
}
