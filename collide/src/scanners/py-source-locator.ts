// scanners/py-source-locator.ts
// Read a Python package's installed source. Unlike Go (module cache) the source
// path is resolved by the parser (see core/pip-manifest.ts) and handed to us on
// ResolvedPackage.sourcePath — it points at a site-packages entry that is either
// a package directory (…/requests) or a single-file module (…/six.py).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 2000; // safety cap for pathological packages

/** Collect .py files for a package source path (a dir tree or a single file). */
export function getPySourceFiles(sourcePath: string): string[] {
  let stat: import("node:fs").Stats;
  try {
    stat = statSync(sourcePath);
  } catch {
    return [];
  }
  if (stat.isFile()) return sourcePath.endsWith(".py") ? [sourcePath] : [];

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
        // skip test/vendor/egg noise
        if (
          e.name === "tests" ||
          e.name === "test" ||
          e.name === "__pycache__" ||
          e.name.endsWith(".dist-info") ||
          e.name.endsWith(".egg-info") ||
          e.name.startsWith(".")
        )
          continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".py")) {
        out.push(full);
      }
    }
  };
  walk(sourcePath);
  return out;
}

/** Read and concatenate .py files into one source blob for pattern scanning. */
export function readPySource(files: string[]): string {
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
