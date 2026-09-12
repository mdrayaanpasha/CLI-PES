// core/lockfile.ts
// Parse package-lock.json → a flat list of resolved packages.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResolvedPackage } from "./types";

interface LockfilePackageEntry {
  version?: string;
  dev?: boolean;
  link?: boolean;
}

interface LockfileV2V3 {
  lockfileVersion?: number;
  packages?: Record<string, LockfilePackageEntry>;
}

/**
 * Derive the package name from a `packages` map key such as
 * "node_modules/foo" or "node_modules/@scope/bar/node_modules/baz".
 * The name is the path segment(s) after the LAST "node_modules/".
 */
function nameFromKey(key: string): string | null {
  const idx = key.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  return key.slice(idx + "node_modules/".length) || null;
}

export function parseLockfile(lockfilePath: string): ResolvedPackage[] {
  const absPath = resolve(lockfilePath);
  const raw = readFileSync(absPath, "utf8");
  const lock = JSON.parse(raw) as LockfileV2V3;
  const baseDir = dirname(absPath);

  if (!lock.packages) {
    throw new Error(
      `Unsupported lockfile: no "packages" map found (need lockfileVersion 2 or 3). ` +
        `Got lockfileVersion=${lock.lockfileVersion}.`,
    );
  }

  const out: ResolvedPackage[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue; // root project
    if (entry.link) continue; // symlinked workspace, not a real install
    const name = nameFromKey(key);
    if (!name || !entry.version) continue;
    out.push({
      name,
      version: entry.version,
      // key is already relative to the lockfile dir, e.g. "node_modules/foo"
      sourcePath: resolve(baseDir, key),
    });
  }
  return out;
}
