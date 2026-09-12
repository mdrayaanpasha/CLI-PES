// scanners/osv.ts
// Scan 1: query osv.dev for KNOWN published vulnerabilities in the resolved set.
// Two-step: querybatch (one POST, returns vuln IDs per package) → fetch details
// per unique vuln ID for severity + summary. Network failures degrade to [].

import type { Finding, ResolvedPackage, Scanner, Severity } from "../core/types";

const DEFAULT_ENDPOINT = "https://api.osv.dev";

type FetchLike = typeof fetch;

export interface OsvOptions {
  fetchImpl?: FetchLike;
  endpoint?: string;
  timeoutMs?: number;
  /** OSV ecosystem string, e.g. "npm" or "Go". Defaults to "npm". */
  ecosystem?: string;
  /** called with a human-readable warning when OSV is unreachable */
  onWarn?: (msg: string) => void;
}

// ── osv.dev response shapes (only the fields we use) ──
interface QueryBatchResponse {
  results: Array<{ vulns?: Array<{ id: string }> }>;
}
interface VulnDetail {
  id: string;
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
}

async function withTimeout<T>(
  p: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await p(ctl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Map an OSV vuln's severity signals to our low/medium/high scale. */
export function mapSeverity(v: VulnDetail): Severity {
  const label = v.database_specific?.severity?.toUpperCase();
  if (label) {
    if (label === "CRITICAL" || label === "HIGH") return "high";
    if (label === "MODERATE" || label === "MEDIUM") return "medium";
    if (label === "LOW") return "low";
  }
  // fall back to a CVSS vector score if present, e.g. "CVSS:3.1/.../"
  const cvss = v.severity?.find((s) => s.type.startsWith("CVSS"));
  const m = cvss?.score.match(/\/([0-9]+(?:\.[0-9]+)?)$/) ?? null; // trailing numeric score, if any
  const score = m ? Number(m[1]) : NaN;
  if (!Number.isNaN(score)) {
    if (score >= 7) return "high";
    if (score >= 4) return "medium";
    return "low";
  }
  return "medium"; // unknown → don't under-report
}

export function createOsvScanner(opts: OsvOptions = {}): Scanner {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 15000;
  const ecosystem = opts.ecosystem ?? "npm";
  const warn = opts.onWarn ?? ((m: string) => console.error(`[osv] ${m}`));

  async function batchQuery(pkgs: ResolvedPackage[]): Promise<(string[] | undefined)[]> {
    const body = {
      queries: pkgs.map((p) => ({
        package: { name: p.name, ecosystem },
        version: p.version,
      })),
    };
    const res = await withTimeout(
      (signal) =>
        fetchImpl(`${endpoint}/v1/querybatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      timeoutMs,
    );
    if (!res.ok) throw new Error(`querybatch HTTP ${res.status}`);
    const data = (await res.json()) as QueryBatchResponse;
    return data.results.map((r) => r.vulns?.map((v) => v.id));
  }

  async function fetchVuln(id: string): Promise<VulnDetail | null> {
    try {
      const res = await withTimeout(
        (signal) => fetchImpl(`${endpoint}/v1/vulns/${encodeURIComponent(id)}`, { signal }),
        timeoutMs,
      );
      if (!res.ok) return null;
      return (await res.json()) as VulnDetail;
    } catch {
      return null;
    }
  }

  return {
    name: "osv",
    scan: async (pkgs): Promise<Finding[]> => {
      if (pkgs.length === 0) return [];

      let perPackageIds: (string[] | undefined)[];
      try {
        perPackageIds = await batchQuery(pkgs);
      } catch (err) {
        warn(`skipping OSV scan — ${(err as Error).message}`);
        return [];
      }

      // fetch each unique vuln's details once
      const uniqueIds = [...new Set(perPackageIds.flatMap((ids) => ids ?? []))];
      const details = new Map<string, VulnDetail | null>();
      await Promise.all(
        uniqueIds.map(async (id) => details.set(id, await fetchVuln(id))),
      );

      const findings: Finding[] = [];
      perPackageIds.forEach((ids, i) => {
        if (!ids) return;
        const pkg = pkgs[i];
        for (const id of ids) {
          const v = details.get(id);
          findings.push({
            scanner: "osv",
            severity: v ? mapSeverity(v) : "medium",
            target: id,
            owners: [`${pkg.name}@${pkg.version}`],
            message: v?.summary ?? v?.details?.split("\n")[0] ?? `Known vulnerability ${id}`,
          });
        }
      });
      return findings;
    },
  };
}

// Default instance used by the CLI registry (npm ecosystem).
export const osvScanner: Scanner = createOsvScanner();

// Go-ecosystem instance for Go module manifests.
export const goOsvScanner: Scanner = createOsvScanner({ ecosystem: "Go" });

// PyPI-ecosystem instance for Python (pip) manifests.
export const pyOsvScanner: Scanner = createOsvScanner({ ecosystem: "PyPI" });

// crates.io-ecosystem instance for Rust (Cargo) manifests.
export const rustOsvScanner: Scanner = createOsvScanner({ ecosystem: "crates.io" });
