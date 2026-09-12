// scanners/osv.ts
// Scan 1: network call to the OSV database — no AST.

import type { ResolvedPackage, Scanner, Severity } from "../core/types";

interface OsvResult {
  package: string;
  version: string;
  severity: Severity;
  summary: string;
}

async function batchQueryOSV(pkgs: ResolvedPackage[]): Promise<OsvResult[]> {
  // TODO: POST to https://api.osv.dev/v1/querybatch with the resolved set,
  //       then map vulnerabilities back to packages.
  return [];
}

export const osvScanner: Scanner = {
  name: "osv",
  scan: async (pkgs) => {
    const results = await batchQueryOSV(pkgs);
    return results.map((r) => ({
      scanner: "osv" as const,
      severity: r.severity,
      target: r.package,
      owners: [`${r.package}@${r.version}`],
      message: r.summary,
    }));
  },
};
