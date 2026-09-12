# Distribution & plugin plan — one engine, many front ends

Two questions this answers:

1. **Cross-system UX** — is it one unified command across all ecosystems/platforms, or many?
2. **Plugin packaging** — how does Collide become a plugin for Claude Code, Codex, and other CLIs?

Both collapse to the same principle: **keep a single core engine, and add thin
front ends around it.** Nothing here is implemented yet — design only.

---

## 0. The layering (the whole idea in one picture)

```
                     ┌───────────────────────────────────────────┐
                     │  CORE ENGINE (pure, no I/O opinions)        │
                     │  detectAndParse() · runScans() · Finding[]  │
                     └───────────────────────────────────────────┘
                        ▲              ▲                 ▲
          ┌─────────────┘              │                 └──────────────┐
   ┌──────┴───────┐          ┌─────────┴────────┐          ┌───────────┴─────────┐
   │ CLI front end │          │ MCP server front │          │ (library import)    │
   │ collide scan  │          │ end (stdio JSON) │          │ import { scan }     │
   │ --format=json │          │ tool: scan_deps  │          │ from "collide"      │
   └──────┬───────┘          └─────────┬────────┘          └─────────────────────┘
          │                            │
   humans + CI +          Claude Code plugin · Codex config · Cursor/Windsurf ·
   dumb shell-outs        any MCP host
```

The core already exists (`runScans`, and after the multi-ecosystem refactor,
`detectAndParse`). The CLI already exists. The **new** piece is the MCP server —
that single addition is what makes it a plugin everywhere.

---

## 1. Cross-system: yes, one unified command

### Across ecosystems (npm + pip + cargo + …)
The parser registry (see [`ecosystems/README.md`](./ecosystems/README.md)) detects the
manifest **by filename**, so one command handles any language:

```bash
collide scan package-lock.json     # npm
collide scan requirements.txt      # pip
collide scan Cargo.lock            # rust
```

Add an **auto-discovery mode** so it's truly one command for a whole project:

```bash
collide scan                       # no path → walk cwd, find every supported
                                   #   manifest, scan all, one merged report
collide scan ./monorepo            # walk a directory tree
```

`walkForManifests(dir)` globs the known filenames (`package-lock.json`,
`requirements.txt`, `poetry.lock`, `Cargo.lock`, `go.sum`, `Gemfile.lock`,
`composer.lock`), parses each, concatenates the `ResolvedPackage[]`. Because every
package now carries its own `ecosystem`, the downstream scanners don't care that the
list is mixed:

- **osv** — OSV's `/v1/querybatch` accepts mixed ecosystems in a *single* POST, so a
  polyglot repo is still one network round-trip.
- **version-conflict** — keyed by `ecosystem + name`, so npm-`redis` and PyPI-`redis`
  don't false-collide.
- **global-state / event-listeners** — run per-package against whatever source exists;
  non-JS packages simply contribute nothing until their language analyzer lands.

The report groups findings by ecosystem in the summary. **One command, any mix of
languages.**

### Across platforms (macOS / Linux / Windows)
It's a Node CLI, so portability is free *if* we stay disciplined:
- Already using `node:path` / `node:fs` — keep it; never hand-concatenate paths.
- The SQLite AST cache (`collide.db`) — confirm the driver ships prebuilt binaries for
  all three OSes, or swap to a pure-JS store. (Flag: this is the one native dep.)
- Distribute on **npm** so `npx collide` / `npx @you/collide` runs identically on every
  OS with no manual install. Same artifact drives the MCP server (below).

---

## 2. Plugin packaging: build the MCP server once

The universal integration point for AI coding CLIs is the **Model Context Protocol**.
Claude Code, Codex, Cursor, and Windsurf all speak MCP over stdio. So:

> Write **one** MCP server that wraps the core engine. Every "plugin" is then just a
> few lines of host-specific config pointing at that same server.

### 2a. The MCP server (`src/mcp/server.ts`, published as a bin)
A small stdio server using `@modelcontextprotocol/sdk`, exposing the engine as tools:

| Tool | Input | Output |
|---|---|---|
| `scan_dependencies` | `{ path?: string, only?: string[] }` | findings JSON: summary counts + per-finding `{scanner, severity, target, owners, message}` |
| `scan_manifest` | `{ file: string }` | same, single manifest |
| `list_ecosystems` | – | supported manifests + OSV ecosystem strings |

It calls the *exact same* `detectAndParse` + `runScans` the CLI uses and returns the
structured `Finding[]` — no reformatting for humans, since the agent consumes JSON.
Stdio transport (JSON-RPC 2.0 on stdin/stdout) is the right choice for a local Node
server. Publish it as a bin (`collide-mcp`) on npm so hosts can launch it with `npx`.

### 2b. Claude Code plugin
Bundle the server + a slash command in a plugin repo:

```
collide-plugin/
├── .claude-plugin/
│   └── plugin.json
├── .mcp.json                 # or inline mcpServers in plugin.json
└── skills/
    └── scan/SKILL.md         # /collide:scan
```

`plugin.json`:
```json
{
  "name": "collide",
  "description": "Dependency vulnerability & collision scanner (npm, pip, cargo, …)",
  "version": "1.0.0",
  "author": { "name": "…" },
  "mcpServers": {
    "collide": {
      "command": "npx",
      "args": ["-y", "@you/collide-mcp"]
    }
  }
}
```
(`${CLAUDE_PLUGIN_ROOT}/servers/collide-mcp.js` instead of `npx` if we vendor the
server inside the plugin rather than pull from npm.)

`skills/scan/SKILL.md`:
```markdown
---
description: Scan this project's dependencies for vulnerabilities and collisions
---
Call the `collide.scan_dependencies` MCP tool on the current project and summarize
findings by severity, most severe first.
```

Distribution: push to a GitHub repo containing a `marketplace.json`; users run
`/plugin marketplace add you/collide-plugin` then `/plugin install @you/collide`.

### 2c. Codex CLI
Same server, registered in `~/.codex/config.toml`:
```toml
[mcp_servers.collide]
type = "stdio"
command = "npx"
args = ["-y", "@you/collide-mcp"]
```
Or one-shot: `codex mcp add --transport stdio collide -- npx -y @you/collide-mcp`.
(Project-scoped configs need `trust_level = "trusted"`.)

### 2d. Cursor / Windsurf / other MCP hosts
Each has its own `mcp.json`-style config with the identical stdio entry
(`command: "npx"`, `args: ["-y", "@you/collide-mcp"]`). No new code.

### 2e. Tools with no MCP support
They just shell out to the CLI — `collide scan --format=json` already emits machine
output. This is the lowest-common-denominator fallback and needs nothing new.

---

## 3. What we actually build (checklist)

| Piece | New? | Enables |
|---|---|---|
| `ecosystem` field + parser registry + auto-discovery | new | unified cross-language command |
| Cross-platform hardening (cache dep, npm publish) | small | runs on any OS via `npx` |
| MCP server wrapping `detectAndParse`+`runScans` | **new, the keystone** | Claude Code, Codex, Cursor, Windsurf |
| Claude Code plugin repo (`plugin.json` + skill + marketplace.json) | new, thin | `/plugin install` |
| Codex / other config snippets (docs) | docs only | copy-paste setup |
| `--format=json` CLI | **already exists** | non-MCP shell-outs, CI |

**Sequence:** publish the CLI to npm → add the MCP server (reuses the engine) →
wrap it in the Claude Code plugin → document the Codex/Cursor config. One engine,
one server, many thin front ends.

---

## 4. Open questions

- npm scope/name for the published packages (`@you/collide`, `@you/collide-mcp`, or a
  single package exposing two bins?).
- Vendor the MCP server inside the Claude Code plugin (offline, pinned) vs. `npx` from
  npm (always latest)? Lean: `npx` for simplicity, document the vendored option.
- MCP tool granularity — one `scan_dependencies` tool, or split per scanner so an
  agent can ask for just OSV vs. just collisions?
- Should the MCP server expose the SQLite AST cache, or run stateless per call?
  (Stateless is simpler for a forked-per-session server; cache is a perf nicety.)
