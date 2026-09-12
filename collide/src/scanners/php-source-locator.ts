// scanners/php-source-locator.ts
// Read a PHP package's installed source. The path is resolved by the parser
// (see core/composer-manifest.ts) and handed to us on ResolvedPackage.sourcePath
// — it points at a vendor package directory (…/vendor/monolog/monolog). We walk
// it for .php files. Mirrors py-source-locator.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 2000; // safety cap for pathological packages

/** Collect .php files under a package source directory. */
export function getPhpSourceFiles(sourcePath: string): string[] {
  let stat: import("node:fs").Stats;
  try {
    stat = statSync(sourcePath);
  } catch {
    return [];
  }
  if (stat.isFile()) return sourcePath.endsWith(".php") ? [sourcePath] : [];

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
        // skip test/vendor noise co-located within a package
        if (
          e.name === "tests" ||
          e.name === "test" ||
          e.name === "Tests" ||
          e.name === "vendor" ||
          e.name.startsWith(".")
        )
          continue;
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".php")) {
        out.push(full);
      }
    }
  };
  walk(sourcePath);
  return out;
}

/** Read and concatenate .php files into one source blob for pattern scanning. */
export function readPhpSource(files: string[]): string {
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
