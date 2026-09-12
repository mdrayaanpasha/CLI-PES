// scanners/shared-ast-extractor.ts
// One AST walk, two output buckets — shared by global-state and event-listeners.

export interface PackageProfile {
  writes: string[];     // global / prototype write targets, e.g. "Array.prototype.flat"
  listeners: string[];  // event-listener registrations, e.g. "window:resize"
}

export function extractPackageProfile(sourceCode: string): PackageProfile {
  // TODO: parse sourceCode to an AST (e.g. @babel/parser) and walk ONCE,
  //       pushing into `writes` and `listeners` as matching nodes are seen.
  return { writes: [], listeners: [] };
}
