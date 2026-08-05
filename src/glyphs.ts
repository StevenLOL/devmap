// Display-glyph selection for console output.
//
// Problem: on Windows, the legacy console / PowerShell decodes this program's UTF-8 output bytes
// with a legacy code page (GBK / 936 on zh-CN). Every multibyte display glyph (braille spinner,
// middle dot, arrows, box-drawing, check/cross marks, emoji) therefore mojibakes (â, Â·, Ã, ...).
// `chcp 65001` only fixes cmd.exe / conhost — PowerShell re-decodes child stdout via
// [Console]::OutputEncoding (default GBK on zh-CN) and is unaffected by chcp. The only fix that is
// correct under EVERY Windows shell (cmd, PowerShell 5.1, pwsh, Developer PowerShell for VS, conhost,
// Windows Terminal) is to emit pure ASCII glyphs on Windows.
//
// On UTF-8 terminals (Windows Terminal, Git Bash, macOS, Linux) we keep the nicer Unicode glyphs.

const WIN = process.platform === "win32";

export const G = {
  spinner: WIN
    ? ["|", "/", "-", "\\"]
    : ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  dot: WIN ? "|" : "·",
  arrow: WIN ? "->" : "→",
  check: WIN ? "[+]" : "✓",
  cross: WIN ? "[x]" : "✗",
  play: WIN ? "*" : "▶",
  mdash: WIN ? "-" : "—",
  hrule: WIN ? "-" : "─",
  scale: WIN ? "vs" : "⚖",
};

// Sanitize a human-readable string for legacy Windows consoles: every remaining multibyte display
// glyph becomes its ASCII equivalent. Idempotent on ASCII; a no-op off Windows.
const MAP: [RegExp, string][] = [
  [/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, ""], // braille spinner frames
  [/🔍/g, ""], // magnifier emoji (query header)
  [/·/g, G.dot],
  [/→/g, G.arrow],
  [/—/g, G.mdash],
  [/─/g, G.hrule],
  [/⚖/g, G.scale],
  [/▶/g, G.play],
  [/✓/g, G.check],
  [/✗/g, G.cross],
];

export function clean(s: string): string {
  if (!WIN) return s;
  let out = s;
  for (const [re, rep] of MAP) out = out.replace(re, rep);
  return out;
}
