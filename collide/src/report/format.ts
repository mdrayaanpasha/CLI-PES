// report/format.ts
// Premium terminal report for scan + profile, or clean JSON for pipes.

import type { Finding, OutputFormat, Severity } from "../core/types";
import type { PackageProfile } from "../scanners/shared-ast-extractor";
import {
  BRAND,
  box,
  c,
  cols,
  gradient,
  INDENT,
  printLogo,
  progressBar,
  rule,
  sevBadge,
  sevDot,
  statCards,
  sym,
  visibleLen,
  boxWidth,
} from "./ui";

export interface NamedProfile {
  name: string;
  version: string;
  profile: PackageProfile;
}

export interface RunMeta {
  lockfilePath: string;
  packageCount: number;
  scanners: string[];
  perScanner: Record<string, number>;
  errored?: string[];
}

const SEV_ORDER: Severity[] = ["high", "medium", "low"];

const SCANNER_LABEL: Record<string, string> = {
  osv: "Known vulnerabilities",
  "global-state": "Global / prototype collisions",
  "event-listeners": "Event listener collisions",
  "version-conflict": "Duplicate versions",
};

const SCANNER_ICON: Record<string, string> = {
  osv: "⬡",
  "global-state": "◈",
  "event-listeners": "⟳",
  "version-conflict": "⧖",
};

// ── scan report ──────────────────────────────────────────────────────────────

export function printReport(
  findings: Finding[],
  format: OutputFormat,
  meta?: RunMeta,
): void {
  if (format === "json") {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  // ── Logo ──
  printLogo("v0.1.0  ·  multi-ecosystem dependency scanner");

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  // ── Stat cards ──
  if (meta) {
    const highColor =
      counts.high > 0 ? c.red : c.green;
    const cards = statCards([
      {
        label: "Packages Scanned",
        value: String(meta.packageCount),
        color: c.cyan,
      },
      {
        label: "Total Findings",
        value: String(findings.length),
        color: findings.length > 0 ? c.yellow : c.green,
      },
      {
        label: "High Severity",
        value: String(counts.high),
        color: highColor,
      },
      {
        label: "Medium / Low",
        value: `${counts.medium} / ${counts.low}`,
        color: c.magenta,
      },
    ]);
    cards.forEach((l) => console.log(l));
    console.log("");
  }

  // ── Scanner breakdown panel ──
  if (meta) {
    const W = boxWidth();
    const barWidth = Math.max(8, Math.min(20, W - 52));
    const maxFindings = Math.max(
      1,
      ...meta.scanners.map((n) => meta.perScanner[n] ?? 0),
    );

    const lines: string[] = meta.scanners.map((name) => {
      const errored = meta.errored?.includes(name);
      const n = meta.perScanner[name] ?? 0;
      const icon = SCANNER_ICON[name] ?? sym.dot;
      const label = SCANNER_LABEL[name] ?? name;

      const bar =
        !errored && n > 0
          ? progressBar(n, maxFindings, barWidth, n > 0 ? c.yellow : c.green)
          : " ".repeat(barWidth);

      const status = errored
        ? c.gray(`${sym.warn} skipped`)
        : n === 0
          ? c.green(`${sym.check} clean`)
          : c.yellow(`${sym.warn} ${n} found`);

      const left =
        gradient(`${icon}`, BRAND[0], BRAND[1]) +
        " " +
        c.bold(c.cyan(name)) +
        c.dim(c.gray(`  ${label}`));

      return cols(left, bar + "  " + status);
    });

    console.log(
      box(lines, {
        title: `${sym.scan} Scanner Results`,
        color: c.gray,
      }),
    );
    console.log("");
  }

  // ── Clean pass ──
  if (findings.length === 0) {
    const W = boxWidth();
    const msg = gradient(
      `  ${sym.check}  All clear — no collisions or vulnerabilities found.`,
      [52, 211, 153],
      [6, 182, 212],
    );
    console.log(
      box([c.bold(msg), c.dim(c.gray("  Your dependencies look healthy."))], {
        title: "✔ PASS",
        color: c.green,
      }),
    );
    console.log("");
    void W;
    return;
  }

  // ── Findings by severity ──
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    console.log("");

    // Section header
    const badge = sevBadge(sev as "high" | "medium" | "low");
    const countLabel = c.dim(
      `  ${group.length} finding${group.length === 1 ? "" : "s"}`,
    );
    console.log(`${INDENT}${badge}${countLabel}`);
    console.log(`${INDENT}${c.gray("─".repeat(boxWidth() - 4))}`);

    for (const f of group) {
      console.log("");

      // Title row
      const dot = sevDot(sev as "high" | "medium" | "low");
      console.log(`${INDENT}${dot}  ${c.bold(f.message)}`);

      // Scanner + target
      const scannerIcon = SCANNER_ICON[f.scanner] ?? sym.diamond;
      const scannerLabel = gradient(
        ` ${scannerIcon} ${f.scanner}`,
        BRAND[0],
        BRAND[1],
      );
      console.log(
        `${INDENT}   ${c.gray(sym.pipe)} ${scannerLabel}  ${c.dim(c.gray(f.target))}`,
      );

      // Owners
      const ownersStr = f.owners.map((o) => c.magenta(c.bold(o))).join(c.gray("  ·  "));
      console.log(
        `${INDENT}   ${c.gray(sym.pipe)} ${c.dim(c.gray("owners"))}  ${ownersStr}`,
      );

      // Owner count bar (visual weight indicator)
      if (f.owners.length > 1) {
        const bar = progressBar(f.owners.length, 8, 16, c.magenta);
        console.log(
          `${INDENT}   ${c.gray(sym.pipe)} ${c.dim(c.gray("spread "))}  ${bar}  ${c.dim(c.gray(`${f.owners.length} pkgs`))}`,
        );
      }
    }
  }

  // ── Verdict footer ──
  console.log("");
  console.log(rule("double"));
  console.log("");

  const isActionNeeded = counts.high > 0;
  const verdict = isActionNeeded
    ? gradient(
        ` ${sym.spark} ACTION NEEDED `,
        [239, 68, 68],
        [251, 146, 60],
      )
    : gradient(` ${sym.warn} REVIEW RECOMMENDED `, [251, 191, 36], [249, 115, 22]);

  const verdictBadge = c.enabled
    ? `\x1b[1m${verdict}\x1b[22m`
    : isActionNeeded
      ? " ACTION NEEDED "
      : " REVIEW ";

  const summary =
    c.bold(`${findings.length} finding${findings.length === 1 ? "" : "s"}`) +
    c.dim(c.gray("  across  ")) +
    c.bold(`${meta?.packageCount ?? "?"} packages`) +
    c.dim(c.gray("  ·  ")) +
    c.red(c.bold(`${counts.high} high`)) +
    c.gray("  ") +
    c.yellow(c.bold(`${counts.medium} medium`)) +
    c.gray("  ") +
    c.blue(c.bold(`${counts.low} low`));

  console.log(`${INDENT}${verdictBadge}`);
  console.log(`${INDENT}${summary}`);
  console.log("");

  // Fix-it hint
  console.log(
    `${INDENT}${c.dim(c.gray(`${sym.arrow} Upgrade `))}` +
      c.cyan("affected packages") +
      c.dim(c.gray(" to resolve OSV findings and remove duplicate versions.")),
  );
  console.log("");
}

// ── profile report (Phase 1) ───────────────────────────────────────────────

export function printProfiles(
  profiles: NamedProfile[],
  format: OutputFormat,
  meta?: Pick<RunMeta, "lockfilePath">,
): void {
  if (format === "json") {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }

  printLogo("v0.1.0  ·  per-package profiler");

  let withSignal = 0;

  const cards = statCards([
    {
      label: "Packages",
      value: String(profiles.length),
      color: c.cyan,
    },
    {
      label: "Lockfile",
      value: (meta?.lockfilePath ?? "—").replace(/^.*[\\/]/, ".../"),
      color: c.gray,
    },
  ]);
  cards.forEach((l) => console.log(l));
  console.log("");

  for (const { name, version, profile } of profiles) {
    const { writes, listeners } = profile;
    if (writes.length === 0 && listeners.length === 0) continue;
    withSignal++;

    const header =
      gradient(`${sym.diamond} `, BRAND[0], BRAND[1]) +
      c.bold(c.magenta(`${name}`)) +
      c.dim(c.gray(`@${version}`));

    const lines: string[] = [];
    if (writes.length) {
      lines.push(
        cols(
          `  ${c.yellow("◈")} ${c.yellow("writes")}    ` +
            writes.map((w) => c.dim(c.gray(w))).join(c.gray(", ")),
          c.dim(c.gray(`${writes.length}`)),
        ),
      );
    }
    if (listeners.length) {
      lines.push(
        cols(
          `  ${c.cyan("⟳")} ${c.cyan("listeners")} ` +
            listeners.map((l) => c.dim(c.gray(l))).join(c.gray(", ")),
          c.dim(c.gray(`${listeners.length}`)),
        ),
      );
    }

    console.log(box(lines, { title: header, color: c.gray }));
    console.log("");
  }

  console.log(rule("double"));
  console.log("");
  console.log(
    `${INDENT}` +
      c.bold(String(profiles.length)) +
      c.dim(c.gray(" packages profiled  ·  ")) +
      c.yellow(String(withSignal)) +
      c.dim(c.gray(" with writes/listeners  ·  ")) +
      c.gray(`${profiles.length - withSignal} quiet`),
  );
  console.log(
    `${INDENT}${c.dim(c.gray(`${sym.arrow} run `))}${c.cyan("collide scan")}${c.dim(c.gray(" to find cross-package collisions"))}`,
  );
  console.log("");
}

// silence unused-import lint for visibleLen (kept for future column work)
void visibleLen;
void boxWidth;
