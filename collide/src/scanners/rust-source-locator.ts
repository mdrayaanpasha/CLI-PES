// scanners/rust-source-locator.ts
// Locate a Rust crate's source on disk. Like Go (and unlike npm), crate source
// does NOT sit next to the manifest — it lives in the cargo registry cache:
//   $CARGO_HOME/registry/src/<registry-host-hash>/<crate>-<version>/**.rs
// (default ~/.cargo/registry/src). The `<registry-host-hash>` segment varies
// per machine/registry (e.g. `index.crates.io-6f17d22bba15001f`), so we search
// every subdir of `.../registry/src`. The base can be overridden with
// COLLIDE_CARGO_SRC — which the tests point at a synthetic cache whose immediate
// children are the `<crate>-<version>` dirs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedPackage } from "../core/types";

/**
 * Resolve the candidate base directories that directly contain `<crate>-<version>`
 * dirs. Tests override with COLLIDE_CARGO_SRC (one dir). Otherwise we return each
 * registry-host subdir under `<cargo-home>/registry/src`.
 */
export function cargoSrcDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.COLLIDE_CARGO_SRC) return [env.COLLIDE_CARGO_SRC];
  const cargoHome = env.CARGO_HOME ?? join(homedir(), ".cargo");
  const srcRoot = join(cargoHome, "registry", "src");
  try {
    return readdirSync(srcRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(srcRoot, e.name));
  } catch {
    return [];
  }
}

/** Absolute path to a crate's extracted source dir in the cache, or null. */
export function crateSourceDir(
  pkg: ResolvedPackage,
  baseDirs: string[] = cargoSrcDirs(),
): string | null {
  for (const base of baseDirs) {
    const dir = join(base, `${pkg.name}-${pkg.version}`);
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // try next base
    }
  }
  return null;
}

const MAX_FILES = 2000; // safety cap for pathological crates

/** Recursively collect .rs files under `dir` (skips tests/examples/benches). */
export function getRustSourceFiles(dir: string): string[] {
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
        if (
          e.name === "tests" ||
          e.name === "examples" ||
          e.name === "benches" ||
          e.name === "target" ||
          e.name.startsWith(".")
        )
          continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".rs")) {
        out.push(full);
      }
    }
  };

  walk(dir);
  return out;
}

/** Read and concatenate .rs files into one source blob for pattern scanning. */
export function readRustSource(files: string[]): string {
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
