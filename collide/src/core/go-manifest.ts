// core/go-manifest.ts
// Parse a Go module manifest (go.sum preferred, go.mod fallback) into the same
// flat ResolvedPackage[] the npm lockfile parser produces. See
// docs/ecosystems/go-modules.md for the format rationale.
//
// Go source for a dependency lives in the module cache, not next to the
// manifest, so ResolvedPackage.sourcePath is left undefined here — the Go path
// is osv + version-conflict only (no AST scanners).

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ResolvedPackage } from "./types";

/**
 * Parse a `go.sum` file.
 *
 * Each line is `<module-path> <version>[/go.mod] <hash>`, e.g.
 *   github.com/gin-gonic/gin v1.9.0 h1:...
 *   github.com/gin-gonic/gin v1.9.0/go.mod h1:...
 * The `/go.mod` and content-hash lines both appear; we collapse them by
 * deduping on `path@version`. The module path IS the name OSV expects (full
 * path, not last segment), and the leading `v` on the version is kept.
 */
export function parseGoSum(content: string): ResolvedPackage[] {
  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;

    const [path, versionField] = line.split(/\s+/);
    if (!path || !versionField) continue;

    // strip the "/go.mod" suffix that marks the module-file hash line
    const version = versionField.replace(/\/go\.mod$/, "");
    if (!version.startsWith("v")) continue; // not a version line

    const id = `${path}@${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name: path, version });
  }
  return out;
}

/**
 * Parse a `go.mod` file's `require` directives — both the single-line form
 * (`require github.com/foo/bar v1.2.3`) and the block form:
 *   require (
 *       github.com/gin-gonic/gin v1.9.0
 *       golang.org/x/sys v0.5.0 // indirect
 *   )
 * Less complete than go.sum for the full graph, so used only as a fallback.
 */
export function parseGoMod(content: string): ResolvedPackage[] {
  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];
  let inRequireBlock = false;

  const add = (path: string, version: string) => {
    if (!path || !version.startsWith("v")) return;
    const id = `${path}@${version}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ name: path, version });
  };

  for (const rawLine of content.split("\n")) {
    // drop line comments (e.g. "// indirect") before parsing
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    if (inRequireBlock) {
      if (line === ")") {
        inRequireBlock = false;
        continue;
      }
      const [path, version] = line.split(/\s+/);
      add(path, version);
      continue;
    }

    if (line === "require (") {
      inRequireBlock = true;
      continue;
    }

    // single-line: "require github.com/foo/bar v1.2.3"
    const single = line.match(/^require\s+(\S+)\s+(\S+)$/);
    if (single) add(single[1], single[2]);
  }
  return out;
}

/** True when the given path looks like a Go manifest we can parse. */
export function isGoManifest(manifestPath: string): boolean {
  const base = basename(manifestPath);
  return base === "go.sum" || base === "go.mod";
}

/**
 * Parse a Go manifest file into ResolvedPackage[], dispatching on filename.
 * `go.sum` uses the sum parser; anything else is treated as `go.mod`.
 */
export function parseGoManifest(manifestPath: string): ResolvedPackage[] {
  const absPath = resolve(manifestPath);
  const content = readFileSync(absPath, "utf8");
  return basename(absPath) === "go.sum"
    ? parseGoSum(content)
    : parseGoMod(content);
}
