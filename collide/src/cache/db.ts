// cache/db.ts
// SQLite wrapper — cache expensive AST profiles keyed by name@version.

import Database from "better-sqlite3";
import { resolve } from "node:path";
import type { ResolvedPackage } from "../core/types";
import type { PackageProfile } from "../scanners/shared-ast-extractor";
import { getPackageSourceFiles, readSource } from "../scanners/source-locator";

/** Cache location. Override with COLLIDE_DB_PATH (used by tests). */
function dbPath(): string {
  return resolve(process.cwd(), process.env.COLLIDE_DB_PATH ?? "collide.db");
}

let db: Database.Database | null = null;
let selectStmt: Database.Statement | null = null;
let insertStmt: Database.Statement | null = null;

function getDb(): Database.Database {
  if (db) return db;
  db = new Database(dbPath());
  db.pragma("journal_mode = WAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS profiles (key TEXT PRIMARY KEY, profile TEXT NOT NULL)",
  );
  selectStmt = db.prepare("SELECT profile FROM profiles WHERE key = ?");
  insertStmt = db.prepare(
    "INSERT OR REPLACE INTO profiles (key, profile) VALUES (?, ?)",
  );
  return db;
}

/**
 * Return a cached profile for the package, or compute it by reading the
 * package source (via source-locator) and running `compute`, then store it.
 * The AST walk runs once per name@version even across multiple scanners.
 */
export async function getOrCache(
  pkg: ResolvedPackage,
  compute: (sourceCode: string) => PackageProfile,
): Promise<PackageProfile> {
  getDb();
  const key = `${pkg.name}@${pkg.version}`;

  const row = selectStmt!.get(key) as { profile: string } | undefined;
  if (row) {
    return JSON.parse(row.profile) as PackageProfile;
  }

  const files = getPackageSourceFiles(pkg);
  const source = readSource(files);
  const profile = compute(source);

  insertStmt!.run(key, JSON.stringify(profile));
  return profile;
}
