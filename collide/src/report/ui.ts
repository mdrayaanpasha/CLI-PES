// report/ui.ts
// Precision terminal interface layer: truecolor, adaptive gradients, and
// razor-sharp structural geometry. Built for elite developer tooling.

const enabled =
  !process.env.NO_COLOR &&
  (!!process.env.FORCE_COLOR ||
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
  bgYellow: (s: string) => (enabled ? `\x1b[43m\x1b[30m${s}\x1b[39m\x1b[49m` : s),
  bgBlue: (s: string) => (enabled ? `\x1b[44m\x1b[97m${s}\x1b[39m\x1b[49m` : s),
  bgGreen: (s: string) => (enabled ? `\x1b[42m\x1b[30m${s}\x1b[39m\x1b[49m` : s),
};

type RGB = [number, number, number];
function fg([r, g, b]: RGB, s: string): string {
  return enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s;
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

// Electric Violet to Cyber Cyan
export const BRAND: [RGB, RGB] = [
  [168, 85, 247],
  [6, 182, 212],
];

// Minimalist architectural symbols — zero noisy iconography
export const sym = {
  ok: enabled ? "│" : "|",
  warn: enabled ? "│" : "|",
  cross: enabled ? "│" : "|",
  dot: enabled ? "▪" : "-",
  diamond: enabled ? "◆" : "*",
  arrow: enabled ? "›" : "->",
  bullet: enabled ? "·" : "-",
  bar: enabled ? "┃" : "|",
  corner: enabled ? "└" : "+",
  tee: enabled ? "├" : "+",
};

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
  return Math.min((process.stdout.columns || 80) - 2, 78);
}

/** Clean, architectural panel layout with subtle structural borders. */
export function box(
  lines: string[],
  opts: { title?: string; color?: (s: string) => string } = {},
): string {
  const paint = opts.color ?? c.gray;
  const W = boxWidth();
  const inner = W - 4;

  const top = (() => {
    if (!opts.title) return paint("┌" + "─".repeat(W - 2) + "┐");
    const label = ` ${opts.title} `;
    const dash = W - 2 - 1 - visibleLen(label);
    return (
      paint("┌─") + c.bold(paint(label)) + paint("─".repeat(Math.max(0, dash)) + "┐")
    );
  })();

  const body = lines.map((ln) => {
    const content = padVisible(truncateVisible(ln, inner), inner);
    return paint("│ ") + content + paint(" │");
  });

  const bottom = paint("└" + "─".repeat(W - 2) + "┘");
  return [top, ...body, bottom].map((l) => INDENT + l).join("\n");
}

export function rule(): string {
  return INDENT + c.gray("─".repeat(boxWidth() - 2));
}

export function cols(left: string, right: string): string {
  const inner = boxWidth() - 4;
  const gap = inner - visibleLen(left) - visibleLen(right);
  return left + " ".repeat(Math.max(1, gap)) + right;
}

void visibleLen;