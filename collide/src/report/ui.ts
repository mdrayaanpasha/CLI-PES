// report/ui.ts
// Precision terminal interface layer: truecolor, adaptive gradients, and
// razor-sharp structural geometry. Built for elite developer tooling.

const forceColor = process.env.FORCE_COLOR;
const enabled =
  !process.env.NO_COLOR &&
  forceColor !== "0" &&
  forceColor !== "false" &&
  (forceColor !== undefined ||
    (!!process.stdout.isTTY && process.env.TERM !== "dumb"));

function wrap(open: number, close: number) {
  return (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
  enabled,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  white: wrap(97, 39),
  bgRed: (s: string) => (enabled ? `\x1b[41m\x1b[97m${s}\x1b[39m\x1b[49m` : s),
  bgYellow: (s: string) =>
    enabled ? `\x1b[43m\x1b[30m${s}\x1b[39m\x1b[49m` : s,
  bgBlue: (s: string) => (enabled ? `\x1b[44m\x1b[97m${s}\x1b[39m\x1b[49m` : s),
  bgGreen: (s: string) =>
    enabled ? `\x1b[42m\x1b[30m${s}\x1b[39m\x1b[49m` : s,
  bgMagenta: (s: string) =>
    enabled ? `\x1b[45m\x1b[97m${s}\x1b[39m\x1b[49m` : s,
  bgCyan: (s: string) =>
    enabled ? `\x1b[46m\x1b[30m${s}\x1b[39m\x1b[49m` : s,
};

type RGB = [number, number, number];
function fg([r, g, b]: RGB, s: string): string {
  return enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s;
}
function bg([r, g, b]: RGB, s: string): string {
  return enabled ? `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m` : s;
}

export function gradient(text: string, from: RGB, to: RGB): string {
  if (!enabled) return text;
  const chars = [...text];
  const n = Math.max(chars.length - 1, 1);
  return chars
    .map((ch, i) => {
      const t = i / n;
      const rgb: RGB = [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
      ];
      return fg(rgb, ch);
    })
    .join("");
}

/** Apply gradient across each character of each line independently */
export function gradientBlock(lines: string[], from: RGB, to: RGB): string[] {
  return lines.map((line) => gradient(line, from, to));
}

// ── Brand palette ────────────────────────────────────────────────────────────

// Electric Violet → Cyber Cyan
export const BRAND: [RGB, RGB] = [
  [168, 85, 247],
  [6, 182, 212],
];

// Red → Orange (for critical/high)
export const DANGER: [RGB, RGB] = [
  [239, 68, 68],
  [251, 146, 60],
];

// Emerald (for pass/clean)
export const SAFE: RGB = [52, 211, 153];

// ── Symbols ──────────────────────────────────────────────────────────────────

export const sym = {
  ok: enabled ? "●" : "[OK]",
  warn: enabled ? "◆" : "[!]",
  cross: enabled ? "✖" : "[X]",
  dot: enabled ? "●" : "*",
  diamond: enabled ? "◆" : "*",
  arrow: enabled ? "→" : "->",
  arrowRight: enabled ? "▶" : ">",
  bullet: enabled ? "›" : "-",
  bar: enabled ? "━" : "=",
  corner: enabled ? "╰" : "+",
  tee: enabled ? "├" : "+",
  check: enabled ? "✔" : "v",
  shield: enabled ? "⬡" : "#",
  spark: enabled ? "⚡" : "!",
  scan: enabled ? "⟳" : "~",
  pipe: enabled ? "│" : "|",
  hbar: enabled ? "─" : "-",
};

// ── ANSI helpers ─────────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;
export function visibleLen(s: string): number {
  return [...s.replace(ANSI_RE, "")].length;
}

function truncateVisible(s: string, max: number): string {
  if (visibleLen(s) <= max) return s;
  const plain = s.replace(ANSI_RE, "");
  return [...plain].slice(0, Math.max(0, max - 1)).join("") + "…";
}

function padVisible(s: string, width: number): string {
  const len = visibleLen(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

export const INDENT = "  ";
export function boxWidth(): number {
  return Math.max(12, Math.min((process.stdout.columns || 80) - 2, 78));
}

// ── Logo ─────────────────────────────────────────────────────────────────────

const LOGO_LINES = [
  " ██████╗ ██████╗ ██╗     ██╗     ██╗██████╗ ███████╗",
  "██╔════╝██╔═══██╗██║     ██║     ██║██╔══██╗██╔════╝",
  "██║     ██║   ██║██║     ██║     ██║██║  ██║█████╗  ",
  "██║     ██║   ██║██║     ██║     ██║██║  ██║██╔══╝  ",
  "╚██████╗╚██████╔╝███████╗███████╗██║██████╔╝███████╗",
  " ╚═════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝╚═════╝ ╚══════╝",
];

const LOGO_VIOLET: RGB = [168, 85, 247];
const LOGO_CYAN: RGB = [6, 182, 212];

/**
 * Render the big ASCII logo with a truecolor vertical gradient
 * (top rows → violet, bottom rows → cyan).
 */
export function printLogo(subtitle: string): void {
  const totalRows = LOGO_LINES.length;
  const W = boxWidth();
  const padLeft = Math.max(0, Math.floor((W - visibleLen(LOGO_LINES[0])) / 2));
  const pad = " ".repeat(padLeft + 2); // +2 for INDENT

  console.log("");

  for (let i = 0; i < totalRows; i++) {
    const t = i / Math.max(totalRows - 1, 1);
    const rowColor: RGB = [
      Math.round(LOGO_VIOLET[0] + (LOGO_CYAN[0] - LOGO_VIOLET[0]) * t),
      Math.round(LOGO_VIOLET[1] + (LOGO_CYAN[1] - LOGO_VIOLET[1]) * t),
      Math.round(LOGO_VIOLET[2] + (LOGO_CYAN[2] - LOGO_VIOLET[2]) * t),
    ];
    const line = enabled
      ? `\x1b[38;2;${rowColor[0]};${rowColor[1]};${rowColor[2]}m${LOGO_LINES[i]}\x1b[39m`
      : LOGO_LINES[i];
    console.log(pad + line);
  }

  // Tagline
  const tag = gradient(
    `  ${sym.shield}  dependency collision & vulnerability scanner  ${sym.shield}`,
    BRAND[0],
    BRAND[1],
  );
  const tagPad = Math.max(
    0,
    Math.floor((W - visibleLen(tag.replace(ANSI_RE, ""))) / 2),
  );
  console.log(
    " ".repeat(tagPad + 2) + (enabled ? c.bold(tag) : subtitle),
  );

  // Version / subtitle dim line
  const vLine = c.dim(c.gray(`  ${sym.hbar}  ${subtitle}  ${sym.hbar}`));
  const vPad = Math.max(
    0,
    Math.floor((W - visibleLen(vLine.replace(ANSI_RE, ""))) / 2),
  );
  console.log(" ".repeat(vPad + 2) + vLine);
  console.log("");
}

// ── Box ───────────────────────────────────────────────────────────────────────

/** High-contrast dashboard panel with a branded title rail. */
export function box(
  lines: string[],
  opts: { title?: string; color?: (s: string) => string } = {},
): string {
  const paint = opts.color ?? c.gray;
  const W = boxWidth();
  const inner = W - 4;

  const top = (() => {
    if (!opts.title) return paint("╭" + "─".repeat(W - 2) + "╮");
    const label = ` ${opts.title} `;
    const dash = W - 2 - 1 - visibleLen(label);
    return (
      paint("╭─") + c.bold(paint(label)) + paint("─".repeat(Math.max(0, dash)) + "╮")
    );
  })();

  const body = lines.map((ln) => {
    const content = padVisible(truncateVisible(ln, inner), inner);
    return paint("│ ") + content + paint(" │");
  });

  const bottom = paint("╰" + "─".repeat(W - 2) + "╯");
  return [top, ...body, bottom].map((l) => INDENT + l).join("\n");
}

// ── Stat card row ─────────────────────────────────────────────────────────────

/**
 * Renders a horizontal row of stat cards:
 *   ╭──────────╮  ╭──────────╮  ╭──────────╮
 *   │  label   │  │  label   │  │  label   │
 *   │  VALUE   │  │  VALUE   │  │  VALUE   │
 *   ╰──────────╯  ╰──────────╯  ╰──────────╯
 */
export function statCards(
  cards: Array<{ label: string; value: string; color?: (s: string) => string }>,
): string[] {
  const W = boxWidth();
  const gap = 2;
  const count = cards.length;
  const cardW = Math.floor((W - gap * (count - 1)) / count);

  function cardLine(
    paint: (s: string) => string,
    content: string,
    inner: number,
  ): string {
    return INDENT + paint("│ ") + padVisible(truncateVisible(content, inner), inner) + paint(" │");
  }

  const inner = cardW - 4;
  const rows: string[][] = cards.map((card) => {
    const paint = card.color ?? c.gray;
    const top = INDENT + paint("╭" + "─".repeat(cardW - 2) + "╮");
    const labelLine = cardLine(paint, c.dim(card.label), inner);
    const valueLine = cardLine(paint, c.bold(card.value), inner);
    const bot = INDENT + paint("╰" + "─".repeat(cardW - 2) + "╯");
    return [top, labelLine, valueLine, bot];
  });

  // Zip rows horizontally
  const lineCount = rows[0].length;
  const out: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    out.push(rows.map((r) => r[i]).join(" ".repeat(gap)));
  }
  return out;
}

// ── Progress bar ──────────────────────────────────────────────────────────────

/** Renders a coloured filled/empty bar of given width. */
export function progressBar(
  filled: number,
  total: number,
  width: number,
  color: (s: string) => string = c.cyan,
): string {
  const pct = total === 0 ? 0 : Math.round((filled / total) * width);
  const empty = width - pct;
  const bar =
    color("█".repeat(Math.max(0, pct))) + c.dim(c.gray("░".repeat(Math.max(0, empty))));
  return bar;
}

// ── Rule / cols ───────────────────────────────────────────────────────────────

export function rule(style: "solid" | "dashed" | "double" = "solid"): string {
  const ch = style === "dashed" ? "╌" : style === "double" ? "═" : "─";
  return INDENT + c.gray(ch.repeat(boxWidth() - 2));
}

export function cols(left: string, right: string): string {
  const inner = boxWidth() - 4;
  const gap = inner - visibleLen(left) - visibleLen(right);
  return left + " ".repeat(Math.max(1, gap)) + right;
}

// ── Severity badge & mini-bar ─────────────────────────────────────────────────

export function sevBadge(
  sev: "high" | "medium" | "low" | "critical",
): string {
  const label = ` ${sev.toUpperCase()} `;
  if (sev === "critical") return c.bgRed(c.bold(` ⚡ ${sev.toUpperCase()} `));
  if (sev === "high") return c.bgRed(c.bold(label));
  if (sev === "medium") return c.bgYellow(c.bold(label));
  return c.bgBlue(c.bold(label));
}

export function sevDot(sev: "high" | "medium" | "low"): string {
  if (sev === "high") return c.red(sym.dot);
  if (sev === "medium") return c.yellow(sym.dot);
  return c.blue(sym.dot);
}

// Expose bg for potential use elsewhere (unused-import safety)
void bg;