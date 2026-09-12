// core/scanner.ts
// The single merge point: run enabled scanners concurrently, flatten findings.

import type { Finding, ResolvedPackage, Scanner } from "./types.js";

export async function runScans(
  packages: ResolvedPackage[],
  enabled: Scanner[],
): Promise<Finding[]> {
  const results = await Promise.all(enabled.map((s) => s.scan(packages)));
  return results.flat();
}
