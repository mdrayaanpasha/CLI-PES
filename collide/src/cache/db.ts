// cache/db.ts
// In-memory / persistent cache — cache expensive AST profiles keyed by name@version.

import * as fs from "node:fs";
import type { ResolvedPackage } from "../core/types";
import type { PackageProfile } from "../scanners/shared-ast-extractor";

const profileCache = new Map<string, PackageProfile>();

/**
 * Return a cached profile for the package, or compute it via `compute`
 * (reading the package source) and store it. AST walking runs once per
 * name@version even though multiple scanners consume the result.
 */
export async function getOrCache(
  pkg: ResolvedPackage,
  compute: (sourceCode: string, packageContext?: string, moduleContext?: string) => PackageProfile,
): Promise<PackageProfile> {
  const key = `${pkg.name}@${pkg.version}`;
  const cached = profileCache.get(key);
  if (cached) {
    return cached;
  }

  let sourceCode = "";
  if (pkg.sourcePath) {
    try {
      sourceCode = await fs.promises.readFile(pkg.sourcePath, "utf-8");
    } catch {
      sourceCode = "";
    }
  }

  const profile = compute(sourceCode, pkg.name, pkg.sourcePath);
  profileCache.set(key, profile);
  return profile;
}

/**
 * Clear the profile cache (primarily for testing).
 */
export function clearCache(): void {
  profileCache.clear();
}

