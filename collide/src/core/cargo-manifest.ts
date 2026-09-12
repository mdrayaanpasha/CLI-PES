// core/cargo-manifest.ts
// Parse a Rust (Cargo / crates.io) manifest into the same flat ResolvedPackage[]
// the npm lockfile parser produces. See docs/ecosystems/rust-cargo.md.
//
// Only `Cargo.lock` is parsed — it is fully resolved and pinned. `Cargo.toml`
// holds semver ranges, not concrete versions, so it is intentionally ignored.
//
// Crate names are already canonical (lowercase, `-`), so no normalization is
// needed. Rust crate source lives in the cargo registry cache
// (~/.cargo/registry/src/**), not next to the lockfile, so sourcePath is left
// undefined here — the Rust path is osv + version-conflict only (no AST
// scanners). See docs/ecosystems/rust-cargo.md §2.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ResolvedPackage } from "./types";

/** True when the given path looks like a Cargo lockfile we can parse. */
export function isCargoManifest(manifestPath: string): boolean {
  return basename(manifestPath) === "Cargo.lock";
}

/**
 * Parse `Cargo.lock` (TOML). We only need `name`/`version`/`source` from each
 * `[[package]]` table, so instead of pulling in a TOML dependency we hand-roll a
 * scan over that tiny, well-structured subset (mirrors the poetry.lock parser):
 * walk lines, and within each `[[package]]` block capture the first
 * `name = "…"`, `version = "…"`, and `source = "…"`.
 *
 * A crate's `source` tells us where it came from. Crates.io packages carry a
 * `registry+https://github.com/rust-lang/crates.io-index` source; git and path
 * dependencies carry `git+…` / are missing the field entirely. OSV can only
 * match registry crates, so git/path/workspace crates are skipped (they still
 * would have counted for version-conflict, but they aren't published versions
 * we can meaningfully compare either).
 */
export function parseCargoLock(content: string): ResolvedPackage[] {
  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];

  let inPackage = false;
  let name: string | null = null;
  let version: string | null = null;
  let source: string | null = null;

  const flush = () => {
    // registry crates only: skip git+/path+ and sourceless (workspace/local)
    const fromRegistry = source !== null && source.startsWith("registry+");
    if (name && version && fromRegistry) {
      const id = `${name}@${version}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ name, version });
      }
    }
    name = null;
    version = null;
    source = null;
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line === "[[package]]") {
      flush(); // close any previous package block
      inPackage = true;
      continue;
    }
    // any other top-level table (e.g. [metadata], [[patch...]]) ends the block
    if (line.startsWith("[") && line !== "[[package]]") {
      flush();
      inPackage = false;
      continue;
    }
    if (!inPackage) continue;

    if (name === null) {
      const nm = line.match(/^name\s*=\s*"([^"]+)"/);
      if (nm) {
        name = nm[1];
        continue;
      }
    }
    if (version === null) {
      const vm = line.match(/^version\s*=\s*"([^"]+)"/);
      if (vm) {
        version = vm[1];
        continue;
      }
    }
    if (source === null) {
      const sm = line.match(/^source\s*=\s*"([^"]+)"/);
      if (sm) source = sm[1];
    }
  }
  flush(); // final block
  return out;
}

/** Parse a Cargo lockfile into ResolvedPackage[]. */
export function parseCargoManifest(manifestPath: string): ResolvedPackage[] {
  const absPath = resolve(manifestPath);
  const content = readFileSync(absPath, "utf8");
  return parseCargoLock(content);
}
