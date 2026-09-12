// core/types.ts
// Shared interfaces — the contract every scanner and the core engine rely on.

export interface ResolvedPackage {
  name: string;
  version: string;
  /** Absolute path to the package source on disk (used by AST scanners). */
  sourcePath?: string;
}

export interface Scanner {
  name: string;
  scan(resolvedPackages: ResolvedPackage[]): Promise<Finding[]>;
}

export type Severity = "low" | "medium" | "high";

export interface Finding {
  scanner: string;   // "global-state" | "event-listeners" | "osv" | "version-conflict"
  severity: Severity;
  target: string;    // e.g. "Array.prototype.flat" or "lodash version conflict"
  owners: string[];  // packages involved
  message: string;
}

export type OutputFormat = "table" | "json";
