// core/scanner.ts
// The single merge point: run enabled scanners concurrently, flatten findings.

import type { Finding, ResolvedPackage, Scanner } from "./types";

export interface ScanHooks {
  onStart?: (scanner: string) => void;
  onDone?: (scanner: string, count: number) => void;
  onError?: (scanner: string, err: unknown) => void;
}

export async function runScans(
  packages: ResolvedPackage[],
  enabled: Scanner[],
  hooks: ScanHooks = {},
): Promise<Finding[]> {
  const results = await Promise.all(
    enabled.map(async (s) => {
      hooks.onStart?.(s.name);
      try {
        const findings = await s.scan(packages);
        hooks.onDone?.(s.name, findings.length);
        return findings;
      } catch (err) {
        hooks.onError?.(s.name, err);
        return [] as Finding[];
      }
    }),
  );
  return results.flat();
}
