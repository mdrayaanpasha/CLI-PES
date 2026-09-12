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
  rule,
  sym,
  visibleLen,
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

function sevBadge(sev: Severity): string {
  const label = ` ${sev.toUpperCase()} `;
  if (sev === "high") return c.bgRed(c.bold(label));
  if (sev === "medium") return c.bgYellow(c.bold(label));
  return c.bgBlue(c.bold(label));
}

function sevDot(sev: Severity): string {
  if (sev === "high") return c.red(sym.dot);
  if (sev === "medium") return c.yellow(sym.dot);
  return c.blue(sym.dot);
}

function header(subtitle: string): void {
  console.log("");
  const title = gradient(" ◆ COLLIDE", BRAND[0], BRAND[1]);
  console.log(
    box([c.bold(title), c.gray(" " + subtitle)], { color: c.magenta }),
  );
}

// ── scan report ──────────────────────────────────────────────────────────

export function printReport(
  findings: Finding[],
  format: OutputFormat,
  meta?: RunMeta,
): void {
  if (format === "json") {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  header("dependency collision & vulnerability scanner");

  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  // ── scorecard panel ──
  if (meta) {
    const lines: string[] = [];
    lines.push(
      cols(
        `${c.gray("Packages")}  ${c.bold(String(meta.packageCount))}`,
        `${c.gray("Findings")}  ${c.bold(String(findings.length))}`,
      ),
    );
    lines.push(
      `${sevDot("high")} ${c.bold(String(counts.high))} high   ` +
        `${sevDot("medium")} ${c.bold(String(counts.medium))} medium   ` +
        `${sevDot("low")} ${c.bold(String(counts.low))} low`,
    );
    lines.push("");
    for (const name of meta.scanners) {
      const errored = meta.errored?.includes(name);
      const n = meta.perScanner[name] ?? 0;
      const status = errored
        ? c.gray(`${sym.warn} skipped`)
        : n === 0
          ? c.green(`${sym.ok} clean`)
          : c.yellow(`${sym.warn} ${n}`);
      const label = SCANNER_LABEL[name] ?? name;
      lines.push(cols(`${c.cyan(name)} ${c.gray(sym.arrow)} ${c.dim(label)}`, status));
    }
    console.log(box(lines, { title: "Scan Summary", color: c.gray }));
  }

  if (findings.length === 0) {
    console.log("");
    console.log(
      `${INDENT}${c.bgGreen(c.bold(" PASS "))} ${c.bold("No issues found.")} ${c.gray("Dependencies look clean.")}`,
    );
    console.log("");
    return;
  }

  // ── findings grouped by severity ──
  for (const sev of SEV_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;

    console.log("");
    console.log(
      `${INDENT}${sevBadge(sev)} ${c.gray(`${group.length} finding${group.length === 1 ? "" : "s"}`)}`,
    );
    for (const f of group) {
      console.log("");
      console.log(`${INDENT}${sevDot(sev)} ${c.bold(f.message)}`);
      console.log(
        `${INDENT}  ${c.gray(sym.bullet)} ${c.cyan(f.scanner)}  ${c.dim(f.target)}`,
      );
      console.log(
        `${INDENT}  ${c.gray(sym.bullet)} ${c.gray("owners:")} ${f.owners.map((o) => c.magenta(o)).join(c.gray(", "))}`,
      );
    }
  }

  // ── verdict footer ──
  console.log("");
  console.log(rule());
  const risk =
    counts.high > 0 ? c.bgRed(c.bold(" ACTION NEEDED ")) : c.bgYellow(c.bold(" REVIEW "));
  console.log(
    `${INDENT}${risk}  ${c.bold(`${findings.length} finding${findings.length === 1 ? "" : "s"}`)} ` +
      `${c.gray("across")} ${c.bold(String(meta?.packageCount ?? "?"))} ${c.gray("packages")}`,
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

  header("per-package profiler");

  let withSignal = 0;
  const quiet = profiles.length;
  const summary: string[] = [];
  summary.push(
    cols(
      `${c.gray("Packages")}  ${c.bold(String(profiles.length))}`,
      meta ? c.dim(meta.lockfilePath.replace(/^.*\//, ".../")) : "",
    ),
  );
  console.log(box(summary, { title: "Profile", color: c.gray }));

  for (const { name, version, profile } of profiles) {
    const { writes, listeners } = profile;
    if (writes.length === 0 && listeners.length === 0) continue;
    withSignal++;
    console.log("");
    console.log(`${INDENT}${c.bold(c.magenta(`${name}@${version}`))}`);
    if (writes.length) {
      console.log(
        `${INDENT}  ${c.yellow("writes")}    ${writes.map((w) => c.dim(w)).join(c.gray(", "))}`,
      );
    }
    if (listeners.length) {
      console.log(
        `${INDENT}  ${c.cyan("listeners")} ${listeners.map((l) => c.dim(l)).join(c.gray(", "))}`,
      );
    }
  }

  console.log("");
  console.log(rule());
  console.log(
    `${INDENT}${c.bold(String(profiles.length))} packages profiled  ${c.gray("·")}  ` +
      `${c.yellow(String(withSignal))} with writes/listeners  ${c.gray("·")}  ${c.gray(`${quiet - withSignal} quiet`)}`,
  );
  console.log(
    `${INDENT}${c.gray(`${sym.arrow} run `)}${c.cyan("collide scan")}${c.gray(" to find cross-package collisions")}`,
  );
  console.log("");
}

// silence unused-import lint for visibleLen (kept for future column work)
void visibleLen;
