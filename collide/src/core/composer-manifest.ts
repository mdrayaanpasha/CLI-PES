// core/composer-manifest.ts
// Parse a PHP (Composer / Packagist) manifest into the same flat
// ResolvedPackage[] the npm lockfile parser produces. See
// docs/ecosystems/php-composer.md.
//
// Only `composer.lock` is parsed — it is JSON, fully resolved and pinned.
// `composer.json` holds semver ranges, not concrete versions, so it is
// intentionally ignored.
//
// Names are `vendor/package` slugs (e.g. `symfony/console`) — kept whole and
// lowercased, since that's what OSV/Packagist expect (Packagist names are
// case-insensitive). A leading `v` is stripped from versions (`v6.3.4` →
// `6.3.4`) — Packagist advisories are keyed without it.
//
// Unlike Rust/Go, PHP vendor source is co-located with the lockfile at
// `vendor/<vendor>/<package>/`, so each package's sourcePath is resolved
// relative to the lockfile when present — the heuristic collision scanners then
// run (mirrors the Python/site-packages model). Packages absent from `vendor/`
// (e.g. `--no-dev` installs) degrade to osv + version-conflict.

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ResolvedPackage } from "./types";

/** True when the given path looks like a Composer lockfile we can parse. */
export function isComposerManifest(manifestPath: string): boolean {
  return basename(manifestPath) === "composer.lock";
}

/**
 * Normalize a Packagist package name: lowercase the `vendor/package` slug.
 * Packagist names are case-insensitive, so `Symfony/Console` and
 * `symfony/console` are the same package.
 */
export function normalizeComposerName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Normalize a Composer version for OSV: strip a single leading `v`
 * (`v6.3.4` → `6.3.4`). Packagist advisories are keyed without the prefix.
 */
export function normalizeComposerVersion(version: string): string {
  return version.trim().replace(/^v(?=\d)/, "");
}

interface ComposerPackageEntry {
  name?: unknown;
  version?: unknown;
}

/**
 * Parse `composer.lock` (JSON). Iterate `packages` + `packages-dev`; each entry
 * contributes `{ name, version }`. Branch/dev versions (`dev-main`, `1.x-dev`)
 * are not concrete releases OSV can match, so they are skipped.
 */
export function parseComposerLock(content: string): ResolvedPackage[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];

  for (const section of ["packages", "packages-dev"]) {
    const list = data[section];
    if (!Array.isArray(list)) continue;
    for (const entry of list as ComposerPackageEntry[]) {
      if (!entry || typeof entry.name !== "string" || typeof entry.version !== "string") {
        continue;
      }
      // skip unresolvable branch/dev versions ("dev-main", "1.2.x-dev")
      if (/(^dev-|-dev$)/.test(entry.version)) continue;

      const name = normalizeComposerName(entry.name);
      const version = normalizeComposerVersion(entry.version);
      if (!name || !version) continue;

      const id = `${name}@${version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ name, version });
    }
  }
  return out;
}

/**
 * Resolve a package's installed source under `vendor/`. Composer lays packages
 * out at `vendor/<vendor>/<package>/` keyed by the (lowercased) slug, so the
 * name maps straight to a directory. Returns undefined when it isn't on disk.
 */
export function packageSourcePath(
  vendorDir: string,
  normalizedName: string,
): string | undefined {
  const candidate = join(vendorDir, ...normalizedName.split("/"));
  try {
    if (statSync(candidate).isDirectory()) return candidate;
  } catch {
    // not installed
  }
  return undefined;
}

/**
 * Parse a Composer lockfile into ResolvedPackage[]. When a `vendor/` directory
 * sits beside the lockfile, each package's sourcePath is resolved so the
 * collision scanners can run.
 */
export function parseComposerManifest(manifestPath: string): ResolvedPackage[] {
  const absPath = resolve(manifestPath);
  const content = readFileSync(absPath, "utf8");
  const packages = parseComposerLock(content);

  const vendorDir = join(dirname(absPath), "vendor");
  let hasVendor = false;
  try {
    hasVendor = statSync(vendorDir).isDirectory();
  } catch {
    // no vendor/ — osv + version-conflict only
  }
  if (hasVendor) {
    for (const pkg of packages) {
      pkg.sourcePath = packageSourcePath(vendorDir, pkg.name);
    }
  }
  return packages;
}
