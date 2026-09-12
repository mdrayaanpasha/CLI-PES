# collide

Dependency-collision scanner for npm projects. One CLI, one core engine, 4 pluggable scanner modules that all implement the same `Scanner` interface.

See [`../design.md`](../design.md) for the full design.

## Structure

```
src/
├── cli.ts                      entry point, arg parsing, scanner registry
├── core/
│   ├── lockfile.ts             parse package-lock.json → ResolvedPackage[]
│   ├── scanner.ts              runScans() — the single merge point
│   └── types.ts                shared interfaces (Scanner, Finding, ...)
├── scanners/
│   ├── shared-ast-extractor.ts one AST walk feeding scans 2 & 3
│   ├── util.ts                 groupBy / groupByTarget helpers
│   ├── osv.ts                  Scan 1 — known vulns (network)
│   ├── global-state.ts         Scan 2 — global/prototype writes (AST)
│   ├── event-listeners.ts      Scan 3 — listener registrations (AST)
│   └── version-conflict.ts     Scan 4 — duplicate versions (lockfile)
├── cache/
│   └── db.ts                   SQLite cache for AST profiles
└── report/
    └── format.ts               table / JSON output
```

## Usage

```bash
collide scan ./package-lock.json                          # all 4 scanners
collide scan ./package-lock.json --only=osv,global-state  # subset
collide scan ./package-lock.json --format=json            # agent/MCP consumption
```

## Dev

```bash
npm install
npm run dev -- scan ./package-lock.json   # via tsx, no build
npm run build && npm start -- scan ...     # compiled
```

## Adding a scanner

1. Create `src/scanners/<name>.ts` exporting a `Scanner`.
2. Import it in `src/cli.ts` and add it to `allScanners`.

No core changes needed — that's the point.

## Status

Blueprint/stub. Core wiring is in place; `TODO`s mark the real logic:
lockfile parsing, the AST walk, OSV queries, and SQLite caching.
