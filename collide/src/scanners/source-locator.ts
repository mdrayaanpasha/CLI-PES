// scanners/source-locator.ts
// Locate a package's JS source on disk (in node_modules) and read it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedPackage } from "../core/types";

const JS_EXTS = [".js", ".cjs", ".mjs"];

/** Does this path point at an existing file? */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a candidate entry (possibly extensionless, possibly a dir) to a
 * concrete JS file path, or null if it can't be resolved to one.
 */
function resolveEntry(dir: string, entry: string): string | null {
  const base = resolve(dir, entry);
  if (isFile(base)) return base;
  for (const ext of JS_EXTS) {
    if (isFile(base + ext)) return base + ext;
  }
  // directory → index.*
  if (existsSync(base)) {
    for (const ext of JS_EXTS) {
      const idx = join(base, "index" + ext);
      if (isFile(idx)) return idx;
    }
  }
  return null;
}

/** Pull string leaf values out of a (possibly nested) package.json "exports". */
function collectExportTargets(exportsField: unknown, acc: string[]): void {
  if (typeof exportsField === "string") {
    acc.push(exportsField);
  } else if (Array.isArray(exportsField)) {
    for (const v of exportsField) collectExportTargets(v, acc);
  } else if (exportsField && typeof exportsField === "object") {
    for (const v of Object.values(exportsField)) collectExportTargets(v, acc);
  }
}

/**
 * Given a resolved package (with sourcePath = its node_modules dir),
 * return absolute paths of JS files worth scanning. Minimal + tolerant:
 * prefer `main`/`module`, fold in `exports` targets, fall back to index.js.
 */
export function getPackageSourceFiles(pkg: ResolvedPackage): string[] {
  const dir = pkg.sourcePath;
  if (!dir || !existsSync(dir)) return [];

  const candidates: string[] = [];
  try {
    const manifestPath = join(dir, "package.json");
    if (isFile(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        main?: string;
        module?: string;
        exports?: unknown;
      };
      if (manifest.main) candidates.push(manifest.main);
      if (manifest.module) candidates.push(manifest.module);
      if (manifest.exports) collectExportTargets(manifest.exports, candidates);
    }
  } catch {
    // malformed manifest → fall through to index.js
  }
  candidates.push("index.js");

  const resolved = new Set<string>();
  for (const c of candidates) {
    // skip non-JS export conditions like "./style.css" or "types"
    const r = resolveEntry(dir, c);
    if (r) resolved.add(r);
  }
  return [...resolved];
}

/** Read and concatenate the given files into a single source blob. */
export function readSource(files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    try {
      parts.push(readFileSync(f, "utf8"));
    } catch {
      // unreadable file → skip
    }
  }
  return parts.join("\n;\n");
}
