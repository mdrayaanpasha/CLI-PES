// core/pip-manifest.ts
// Parse a Python (pip / PyPI) manifest into the same flat ResolvedPackage[] the
// npm lockfile parser produces. See docs/ecosystems/python-pip.md.
//
// Three manifest formats are handled, dispatched by filename:
//   • poetry.lock    — TOML, exact pins (preferred; richest graph)
//   • Pipfile.lock   — JSON, exact pins ("default" + "develop" sections)
//   • requirements.txt — line-based, only `==`-pinned rows are usable
//
// PyPI names are normalized (PEP 503) so `osv` and `version-conflict` both see
// canonical names — otherwise `Flask` and `flask` look like different packages.
//
// Python source lives flat in a venv's site-packages, not next to the manifest
// the way node_modules does. When a `.venv`/`venv` is discoverable beside the
// manifest, each package's sourcePath is resolved so the collision scanners can
// run; otherwise sourcePath is left undefined (osv + version-conflict only).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ResolvedPackage } from "./types";

/**
 * Normalize a PyPI project name per PEP 503: lowercase, and collapse any run of
 * `-`, `_`, or `.` to a single `-`. `zope.interface` → `zope-interface`,
 * `ruamel_yaml` → `ruamel-yaml`, `Flask` → `flask`.
 */
export function normalizePyName(name: string): string {
  return name.trim().toLowerCase().replace(/[-_.]+/g, "-");
}

/** Strip a bracketed extras suffix: `requests[security]` → `requests`. */
function stripExtras(name: string): string {
  return name.replace(/\[.*$/, "");
}

/** True when the given path looks like a Python manifest we can parse. */
export function isPipManifest(manifestPath: string): boolean {
  const base = basename(manifestPath);
  return (
    base === "poetry.lock" ||
    base === "Pipfile.lock" ||
    base === "requirements.txt"
  );
}

/** Result of parsing, including a count of rows we had to skip (unpinned). */
export interface PipParseResult {
  packages: ResolvedPackage[];
  /** requirements rows skipped because they were not exactly `==`-pinned. */
  skipped: number;
}

/**
 * Parse `requirements.txt`. Only rows exactly pinned with `==` are usable — a
 * version range can't be sent to OSV as a single version. Editable (`-e`), VCS
 * (`git+…`), and option lines (`-r other.txt`) are skipped. Inline `# comments`,
 * environment markers (`; python_version < "3.9"`) and extras are stripped.
 */
export function parseRequirements(content: string): PipParseResult {
  const seen = new Set<string>();
  const packages: ResolvedPackage[] = [];
  let skipped = 0;

  for (const rawLine of content.split("\n")) {
    // drop inline comments and environment markers, then trim
    let line = rawLine.replace(/#.*$/, "").split(";")[0].trim();
    if (!line) continue;
    // line continuations: a trailing backslash is just noise for our purposes
    line = line.replace(/\\$/, "").trim();
    if (!line) continue;

    // skip editable installs, option lines, and VCS/URL requirements
    if (line.startsWith("-") || /^[a-z+]+:\/\//i.test(line) || line.includes("://")) {
      skipped++;
      continue;
    }

    const m = line.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/);
    if (!m) {
      // has a name but not exactly pinned (>=, ~=, bare) → can't scan it
      if (/^[A-Za-z0-9._-]+/.test(line)) skipped++;
      continue;
    }

    const name = normalizePyName(stripExtras(m[1]));
    const version = m[2];
    const id = `${name}@${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    packages.push({ name, version });
  }
  return { packages, skipped };
}

/**
 * Parse `Pipfile.lock` (JSON). Both the `default` and `develop` sections list
 * `<name>: { "version": "==1.2.3" }`; strip the leading `==`.
 */
export function parsePipfileLock(content: string): ResolvedPackage[] {
  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }

  for (const section of ["default", "develop"]) {
    const deps = data[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [rawName, spec] of Object.entries(deps as Record<string, unknown>)) {
      const versionField = (spec as { version?: unknown })?.version;
      if (typeof versionField !== "string") continue;
      const version = versionField.replace(/^==/, "").trim();
      if (!version) continue;
      const name = normalizePyName(stripExtras(rawName));
      const id = `${name}@${version}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ name, version });
    }
  }
  return out;
}

/**
 * Parse `poetry.lock` (TOML). We only need the `name`/`version` from each
 * `[[package]]` table, so instead of pulling in a TOML dependency we hand-roll a
 * scan over that tiny, well-structured subset: walk lines, and within each
 * `[[package]]` block capture the first `name = "…"` and `version = "…"`.
 */
export function parsePoetryLock(content: string): ResolvedPackage[] {
  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];

  let inPackage = false;
  let name: string | null = null;
  let version: string | null = null;

  const flush = () => {
    if (name && version) {
      const norm = normalizePyName(name);
      const id = `${norm}@${version}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ name: norm, version });
      }
    }
    name = null;
    version = null;
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();

    if (line === "[[package]]") {
      flush(); // close any previous package block
      inPackage = true;
      continue;
    }
    // any other top-level table (e.g. [metadata]) ends the package section
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
      if (vm) version = vm[1];
    }
  }
  flush(); // final block
  return out;
}

// ── venv / site-packages source resolution ──────────────────────────────────

const VENV_DIRS = ["venv", ".venv", "env", ".env"];

/** Find a site-packages directory beside the manifest, or null. Looks in the
 *  common venv locations (e.g. `.venv/lib/pythonX.Y/site-packages`). */
export function findSitePackages(manifestDir: string): string | null {
  for (const venv of VENV_DIRS) {
    const lib = join(manifestDir, venv, "lib");
    let pyDirs: string[];
    try {
      pyDirs = readdirSync(lib).filter((d) => d.startsWith("python"));
    } catch {
      continue;
    }
    for (const py of pyDirs) {
      const sp = join(lib, py, "site-packages");
      try {
        if (statSync(sp).isDirectory()) return sp;
      } catch {
        // keep looking
      }
    }
    // Windows layout: <venv>/Lib/site-packages
    const winSp = join(manifestDir, venv, "Lib", "site-packages");
    try {
      if (statSync(winSp).isDirectory()) return winSp;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Resolve a package's installed source in site-packages. pip installs the
 * import package under a name derived from the distribution name; try the
 * normalized name with `-`→`_` (the usual import form), then a single-file
 * module, then the raw normalized name.
 */
export function packageSourcePath(
  sitePackages: string,
  normalizedName: string,
): string | undefined {
  const underscore = normalizedName.replace(/-/g, "_");
  const candidates = [
    join(sitePackages, underscore),
    join(sitePackages, underscore + ".py"),
    join(sitePackages, normalizedName),
    join(sitePackages, normalizedName + ".py"),
  ];
  for (const c of candidates) {
    try {
      statSync(c);
      return c;
    } catch {
      // try next
    }
  }
  return undefined;
}

/**
 * Parse a Python manifest into ResolvedPackage[], dispatching on filename. When
 * a venv's site-packages is discoverable beside the manifest, each package's
 * sourcePath is resolved so the collision scanners can run.
 */
export function parsePipManifest(manifestPath: string): ResolvedPackage[] {
  const absPath = resolve(manifestPath);
  const content = readFileSync(absPath, "utf8");
  const base = basename(absPath);

  let packages: ResolvedPackage[];
  if (base === "poetry.lock") {
    packages = parsePoetryLock(content);
  } else if (base === "Pipfile.lock") {
    packages = parsePipfileLock(content);
  } else {
    const res = parseRequirements(content);
    if (res.skipped > 0) {
      process.stderr.write(
        `  [pip] skipped ${res.skipped} unpinned/non-== requirement row(s) — not scannable.\n`,
      );
    }
    packages = res.packages;
  }

  // attach source paths when a venv is available beside the manifest
  const sitePackages = findSitePackages(dirname(absPath));
  if (sitePackages) {
    for (const pkg of packages) {
      pkg.sourcePath = packageSourcePath(sitePackages, pkg.name);
    }
  }
  return packages;
}
