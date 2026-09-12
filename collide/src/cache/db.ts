// cache/db.ts
// SQLite wrapper — cache expensive AST profiles keyed by name@version.

import type { ResolvedPackage } from "../core/types";
import type { PackageProfile } from "../scanners/shared-ast-extractor";

/**
 * Return a cached profile for the package, or compute it via `compute`
 * (reading the package source) and store it. AST walking runs once per
 * name@version even though multiple scanners consume the result.
 */
export async function getOrCache(
  pkg: ResolvedPackage,
  compute: (sourceCode: string) => PackageProfile,
): Promise<PackageProfile> {
  const _key = `${pkg.name}@${pkg.version}`;
  // TODO: look up `_key` in SQLite; on miss, read pkg.sourcePath,
  //       run compute(), store the JSON, and return it.
  return { writes: [], listeners: [] };
}
