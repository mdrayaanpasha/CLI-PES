# Collide — Design

A dependency-collision scanner for npm projects. One CLI, one core engine, and **4 pluggable scanner modules** that all implement a single shared interface. Scanners are interchangeable plugins: the core never knows what any scanner checks internally — it just calls `.scan()` and merges results.

---

## 1. Goals & Principles

- **Pluggable scanners.** Every check implements the same `Scanner` interface. Adding a 5th scanner = one new file, zero core changes.
- **Independent development.** Each scanner can be built, tested, and demoed on its own. Scan 1 can ship while Scan 4 is half-built.
- **Single merge point.** The core engine fans out to enabled scanners and flattens their `Finding[]` arrays — nothing more.
- **Shared work is factored out.** Scanners 2 & 3 walk the same AST once; they don't each write a walker.
- **Agent-friendly output.** `--format=json` makes the tool trivially wrappable as an MCP tool later.

---

## 2. Folder Structure

```
collide/
├── src/
│   ├── cli.ts                      ← entry point, arg parsing
│   ├── core/
│   │   ├── lockfile.ts             ← parse package-lock.json → ResolvedPackage[]
│   │   ├── scanner.ts              ← runs enabled scanners, merges output
│   │   └── types.ts               ← shared interfaces
│   ├── scanners/
│   │   ├── shared-ast-extractor.ts ← one AST walk feeding scanners 2 & 3
│   │   ├── osv.ts                  ← Scan 1: known vulnerabilities (network)
│   │   ├── global-state.ts         ← Scan 2: global/prototype writes (AST)
│   │   ├── event-listeners.ts      ← Scan 3: listener registrations (AST)
│   │   └── version-conflict.ts     ← Scan 4: duplicate versions (lockfile tree)
│   ├── cache/
│   │   └── db.ts                   ← SQLite wrapper (cache AST profiles)
│   └── report/
│       └── format.ts               ← table / JSON output
```

---

## 3. The Shared Interface

Every scanner is just an object with a `name` and a `scan()` method. This is the contract the whole architecture hangs on.

```ts
// core/types.ts
interface ResolvedPackage {
  name: string;
  version: string;
  // path to source on disk (for AST scanners), etc.
}

interface Scanner {
  name: string;
  scan(resolvedPackages: ResolvedPackage[]): Promise<Finding[]>;
}

interface Finding {
  scanner: string;        // "global-state" | "event-listeners" | "osv" | "version-conflict"
  severity: "low" | "medium" | "high";
  target: string;         // e.g. "Array.prototype.flat" or "lodash version conflict"
  owners: string[];       // packages involved
  message: string;
}
```

**Why this matters:** the core engine doesn't know or care what each scanner checks. It calls `.scan()` on whichever scanners are enabled and merges the `Finding[]` arrays.

---

## 4. Core Engine — the single merge point

```ts
// core/scanner.ts
async function runScans(
  packages: ResolvedPackage[],
  enabled: Scanner[],
): Promise<Finding[]> {
  const results = await Promise.all(enabled.map(s => s.scan(packages)));
  return results.flat();
}
```

That's the entire orchestration layer. Scanners run concurrently; their outputs are flattened into one list for reporting.

---

## 5. The Four Scanners

### Scan 1 — OSV (network, no AST)
Batch-queries the OSV database for known vulnerabilities in the resolved set.

```ts
// scanners/osv.ts
export const osvScanner: Scanner = {
  name: "osv",
  scan: async (pkgs) => {
    const results = await batchQueryOSV(pkgs);      // one HTTP call
    return results.map(r => ({
      scanner: "osv",
      severity: r.severity,
      target: r.package,
      owners: [`${r.package}@${r.version}`],
      message: r.summary,
    }));
  },
};
```

### Scans 2 & 3 — shared AST extractor
Both need the **same AST walk** over package source, differing only in which node shapes they collect. One pass, two output buckets.

```ts
// scanners/shared-ast-extractor.ts
function extractPackageProfile(sourceCode: string) {
  // single AST walk, two buckets
  return { writes: [/* global/prototype writes */], listeners: [/* addEventListener, on(...) */] };
}
```

Each scanner reads the cached profile and groups by target, flagging any target owned by **2+ packages** (that's the collision).

```ts
// scanners/global-state.ts
export const globalStateScanner: Scanner = {
  name: "global-state",
  scan: async (pkgs) => {
    const profiles = await Promise.all(pkgs.map(p => getOrCache(p, extractPackageProfile)));
    return groupByTarget(profiles, "writes")
      .filter(g => g.owners.length >= 2)
      .map(g => ({ scanner: "global-state", severity: "medium", ...g }));
  },
};

// scanners/event-listeners.ts — same profiles, different bucket
export const eventListenerScanner: Scanner = {
  name: "event-listeners",
  scan: async (pkgs) => {
    const profiles = await Promise.all(pkgs.map(p => getOrCache(p, extractPackageProfile)));
    return groupByTarget(profiles, "listeners")
      .filter(g => g.owners.length >= 2)
      .map(g => ({ scanner: "event-listeners", severity: "medium", ...g }));
  },
};
```

> Once you build the extractor + one of these scanners, the other is essentially free.

### Scan 4 — version conflict (pure lockfile tree, no AST)
Groups resolved packages by name; flags any name resolved to more than one version.

```ts
// scanners/version-conflict.ts
export const versionConflictScanner: Scanner = {
  name: "version-conflict",
  scan: async (pkgs) => {
    const byName = groupBy(pkgs, p => p.name);
    return Object.entries(byName)
      .filter(([_, versions]) => new Set(versions.map(v => v.version)).size > 1)
      .map(([name, versions]) => ({
        scanner: "version-conflict",
        severity: "low",
        target: name,
        owners: versions.map(v => `${name}@${v.version}`),
        message: `Multiple versions of ${name} in dependency tree`,
      }));
  },
};
```

---

## 6. Caching

AST extraction is the expensive step and package source is immutable per version. `cache/db.ts` wraps SQLite keyed by `name@version`; `getOrCache(pkg, extractPackageProfile)` returns a cached profile or computes and stores it. Scanners 2 & 3 share the same cache entry — the walk runs once per package even though two scanners consume it.

---

## 7. CLI

```bash
collide scan ./package-lock.json                          # runs all 4
collide scan ./package-lock.json --only=osv,global-state  # subset
collide scan ./package-lock.json --format=json            # for MCP/agent consumption
```

```ts
// cli.ts
const allScanners = [
  osvScanner,
  globalStateScanner,
  eventListenerScanner,
  versionConflictScanner,
];

const enabled = args.only
  ? allScanners.filter(s => args.only.includes(s.name))
  : allScanners;

const packages = parseLockfile(args.lockfilePath);
const findings = await runScans(packages, enabled);
printReport(findings, args.format);
```

---

## 8. Data Flow

```
package-lock.json
      │  lockfile.ts
      ▼
ResolvedPackage[] ───────────────┐
      │                          │
      ▼ (AST scanners)           ▼ (non-AST scanners)
getOrCache + extractProfile   batchQueryOSV / groupBy
      │                          │
      ├─ global-state ─┐         ├─ osv
      └─ event-listeners┤        └─ version-conflict
                        │
                        ▼
                 runScans() → Finding[].flat()
                        │
                        ▼ format.ts
               table  |  JSON output
```

---

## 9. Why This Design Works

- **Demo in pieces.** Each scanner is independently buildable/testable — ship Scan 1 while Scan 4 is unfinished.
- **Scans 2+3 are nearly free.** The shared extractor means the second AST scanner is just a different bucket + filter.
- **Trivial MCP wrapper later.** Call `runScans()` inside an MCP tool handler instead of the CLI command — core untouched.
- **Open for extension.** A new scanner is one file implementing `Scanner`, plus one entry in `allScanners`.

---

## 10. Future Extensions

- **Scanner #5+**: e.g. license conflicts, postinstall-script auditing, typosquat detection — each a single new file.
- **MCP server**: thin handler over `runScans()` for agent consumption.
- **Severity policy / thresholds**: configurable exit codes for CI gating.
- **Parallel source fetching**: prefetch package tarballs before AST scanners run.
