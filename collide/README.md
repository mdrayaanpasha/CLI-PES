# dep-collide

Multi-ecosystem dependency-collision & vulnerability scanner. One core engine, pluggable scanner modules that all implement the same `Scanner` interface, across **npm, Go, Python, Rust, and PHP**. Ships as a **CLI** (`collide`) and an **MCP server** (`collide-mcp`) so Claude and other agents can call it as a tool.

See [`../design.md`](../design.md) for the full design.

## Install

```bash
npx -p dep-collide collide scan ./package-lock.json    # run without installing
npm install -g dep-collide                              # or install the `collide` binary globally
collide scan ./package-lock.json                        # …then just `collide`
```

Requires Node.js ≥ 18. The package installs two binaries: `collide` (the CLI)
and `collide-mcp` (the MCP server).

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

## Ecosystems

The ecosystem is picked from the manifest filename; each maps to the same four
scanner interface (osv · global-state · event-listeners · version-conflict).

| Ecosystem | Manifests | Source scanners |
|---|---|---|
| npm | `package-lock.json` | AST walk over `node_modules` |
| Go | `go.sum`, `go.mod` | heuristic scan of the module cache (`$GOMODCACHE`) |
| Python | `requirements.txt`, `poetry.lock`, `Pipfile.lock` | heuristic scan of a venv's `site-packages` (when discoverable) |
| Rust | `Cargo.lock` | heuristic scan of the cargo registry cache (`~/.cargo/registry/src`, or `$COLLIDE_CARGO_SRC`) |
| PHP | `composer.lock` | heuristic scan of `vendor/<vendor>/<package>/` beside the lockfile |

```bash
collide scan ./go.sum                                     # Go modules
collide scan ./requirements.txt                           # Python (pip / PyPI)
collide scan ./Cargo.lock                                 # Rust (Cargo / crates.io)
collide scan ./composer.lock                              # PHP (Composer / Packagist)
```

For Python, `osv` + `version-conflict` run off the manifest alone; the
collision scanners (`global-state`, `event-listeners`) additionally read
installed source when a `.venv`/`venv` sits beside the manifest. See
[`docs/ecosystems/python-pip.md`](./docs/ecosystems/python-pip.md).

## Use with Claude (MCP)

`dep-collide` ships an MCP server that exposes a single `scan_dependencies` tool.
Add it to your MCP client config (Claude Desktop, Claude Code, etc.):

```json
{
  "mcpServers": {
    "collide": {
      "command": "npx",
      "args": ["-y", "-p", "dep-collide", "collide-mcp"]
    }
  }
}
```

Or, with Claude Code:

```bash
claude mcp add collide -- npx -y -p dep-collide collide-mcp
```

Then ask Claude to "scan my dependencies at ./package-lock.json" — it calls the
tool and gets structured findings (ecosystem, package count, severity counts,
and every finding) back as JSON.

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
