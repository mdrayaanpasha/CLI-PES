// scanners/go-source-locator.ts
// Locate a Go module's source on disk. Unlike npm, Go source does NOT sit next
// to the manifest — it lives in the module cache:
//   $GOMODCACHE/<escaped-module-path>@<version>/**.go
// (default $GOPATH/pkg/mod, else ~/go/pkg/mod). The cache dir can be overridden
// with COLLIDE_GOMODCACHE, which the tests use to point at a synthetic cache.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedPackage } from "../core/types";

/** Resolve the base module-cache directory (tests override via env). */
export function goModCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.COLLIDE_GOMODCACHE) return env.COLLIDE_GOMODCACHE;
  if (env.GOMODCACHE) return env.GOMODCACHE;
  if (env.GOPATH) return join(env.GOPATH, "pkg", "mod");
  return join(homedir(), "go", "pkg", "mod");
}

/**
 * Escape a module path for the on-disk cache. Go lowercases the path and marks
 * each original uppercase letter with a leading `!` (so `BurntSushi` becomes
 * `!burnt!sushi`), avoiding case-insensitive-filesystem collisions.
 */
export function escapeModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}

/** Absolute path to a module's extracted source dir in the cache, or null. */
export function moduleSourceDir(
  pkg: ResolvedPackage,
  baseDir: string = goModCacheDir(),
): string | null {
  const dir = join(baseDir, `${escapeModulePath(pkg.name)}@${pkg.version}`);
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

const MAX_FILES = 2000; // safety cap for pathological modules

/** Recursively collect non-test .go files under `dir` (skips testdata/vendor). */
export function getGoSourceFiles(dir: string): string[] {
  const out: string[] = [];

  const walk = (d: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "testdata" || e.name === "vendor" || e.name.startsWith("."))
          continue;
        walk(full);
      } else if (
        e.isFile() &&
        e.name.endsWith(".go") &&
        !e.name.endsWith("_test.go")
      ) {
        out.push(full);
      }
    }
  };

  walk(dir);
  return out;
}

/** Read and concatenate .go files into one source blob for pattern scanning. */
export function readGoSource(files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    try {
      parts.push(readFileSync(f, "utf8"));
    } catch {
      // unreadable file → skip
    }
  }
  return parts.join("\n");
}
