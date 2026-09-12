// core/lockfile.ts
// Parse package-lock.json → a flat list of resolved packages.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedPackage } from "./types.js";

/**
 * Resolves the primary JS/TS entry point for a package directory.
 */
export function resolvePackageEntryPoint(pkgDir: string): string {
  try {
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      if (pkgJson.main && typeof pkgJson.main === "string") {
        const candidate = path.join(pkgDir, pkgJson.main);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
        for (const ext of [".js", ".mjs", ".cjs", ".ts", "/index.js"]) {
          const withExt = candidate + ext;
          if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
            return withExt;
          }
        }
      }
      if (pkgJson.module && typeof pkgJson.module === "string") {
        const candidate = path.join(pkgDir, pkgJson.module);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
    }
  } catch {
    // ignore errors
  }

  // Common fallbacks
  for (const fallback of ["index.js", "index.mjs", "index.cjs", "index.ts", "main.js"]) {
    const candidate = path.join(pkgDir, fallback);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return path.join(pkgDir, "index.js");
}

/**
 * Parse package-lock.json (supporting v1, v2, and v3 lockfiles)
 * into a flat list of ResolvedPackage entries.
 */
export function parseLockfile(lockfilePath: string): ResolvedPackage[] {
  const absoluteLockfilePath = path.resolve(lockfilePath);
  const projectRoot = path.dirname(absoluteLockfilePath);

  const content = fs.readFileSync(absoluteLockfilePath, "utf-8");
  const lockfile = JSON.parse(content);
  const resolved: ResolvedPackage[] = [];

  // Lockfile v2 / v3: "packages" map
  if (lockfile.packages && typeof lockfile.packages === "object") {
    for (const [pkgPath, pkgInfo] of Object.entries<any>(lockfile.packages)) {
      // Skip top-level root package ("")
      if (!pkgPath || pkgPath === "") {
        continue;
      }

      const name =
        pkgInfo.name ||
        pkgPath.replace(/^.*node_modules\//, "");
      const version = pkgInfo.version || "0.0.0";
      const fullPkgDir = path.join(projectRoot, pkgPath);
      const sourcePath = resolvePackageEntryPoint(fullPkgDir);

      resolved.push({
        name,
        version,
        sourcePath,
      });
    }
    return resolved;
  }

  // Lockfile v1: recursive "dependencies" map
  if (lockfile.dependencies && typeof lockfile.dependencies === "object") {
    function walkDependencies(deps: Record<string, any>, currentDir: string) {
      for (const [name, depInfo] of Object.entries(deps)) {
        const version = depInfo.version || "0.0.0";
        const pkgDir = path.join(currentDir, "node_modules", name);
        const sourcePath = resolvePackageEntryPoint(pkgDir);

        resolved.push({
          name,
          version,
          sourcePath,
        });

        if (depInfo.dependencies && typeof depInfo.dependencies === "object") {
          walkDependencies(depInfo.dependencies, pkgDir);
        }
      }
    }

    walkDependencies(lockfile.dependencies, projectRoot);
    return resolved;
  }

  return resolved;
}

