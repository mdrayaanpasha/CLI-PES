// cache/db.ts
// SQLite wrapper — cache expensive AST profiles keyed by name@version.

import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ResolvedPackage } from "../core/types";
import type { PackageProfile } from "../scanners/shared-ast-extractor";

let dbInstance: DatabaseSync | null = null;
let currentDbLocation = process.env.COLLIDE_CACHE_DB || ":memory:";

/**
 * Get or initialize the SQLite database instance.
 */
export function getDb(customLocation?: string): DatabaseSync {
  const targetLocation = customLocation || currentDbLocation;
  if (!dbInstance || (customLocation && customLocation !== currentDbLocation)) {
    if (dbInstance) {
      try {
        dbInstance.close();
      } catch {
        // ignore
      }
    }
    currentDbLocation = targetLocation;
    dbInstance = new DatabaseSync(currentDbLocation);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS ast_profiles (
        key TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }
  return dbInstance;
}

/**
 * Configure the SQLite database storage location.
 */
export function setDbLocation(location: string): void {
  currentDbLocation = location;
  getDb(location);
}

/**
 * Close the active database connection if open.
 */
export function closeDb(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore
    }
    dbInstance = null;
  }
}

/**
 * Generate a canonical cache key for a resolved package.
 */
export function getCacheKey(pkg: ResolvedPackage): string {
  const name = pkg.name || "unknown";
  const version = pkg.version || "0.0.0";
  return `${name}@${version}`;
}

/**
 * Return a cached profile for the package from SQLite, or compute it via `compute`
 * (reading the package source) and store it in SQLite.
 * AST walking runs once per name@version even though multiple scanners consume the result.
 */
export async function getOrCache(
  pkg: ResolvedPackage,
  compute: (sourceCode: string, packageContext?: string, moduleContext?: string) => PackageProfile,
): Promise<PackageProfile> {
  const key = getCacheKey(pkg);
  const db = getDb();

  const selectStmt = db.prepare("SELECT profile FROM ast_profiles WHERE key = ?");
  const row = selectStmt.get(key) as { profile: string } | undefined;

  if (row && typeof row.profile === "string") {
    try {
      const parsed = JSON.parse(row.profile) as PackageProfile;
      if (parsed && Array.isArray(parsed.writes) && Array.isArray(parsed.listeners)) {
        return parsed;
      }
    } catch {
      // Corrupted cached JSON, fall through to recompute and overwrite
    }
  }

  let sourceCode = "";
  if (pkg.sourcePath) {
    try {
      sourceCode = await fs.promises.readFile(pkg.sourcePath, "utf-8");
    } catch {
      sourceCode = "";
    }
  }

  const profile = compute(sourceCode, pkg.name, pkg.sourcePath);
  const serialized = JSON.stringify(profile);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO ast_profiles (key, profile, created_at)
    VALUES (?, ?, ?)
  `);
  insertStmt.run(key, serialized, Date.now());

  return profile;
}

/**
 * Clear all cached profiles from the database (primarily for testing).
 */
export function clearCache(): void {
  const db = getDb();
  db.exec("DELETE FROM ast_profiles");
}


