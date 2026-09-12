# Go (modules) — support plan

> Prerequisite: shared plumbing in [`README.md`](./README.md).
>
> OSV ecosystem string: **`Go`**

Go is well-served by OSV (Google runs both OSV and Go's vuln DB, so coverage is
excellent), and the lockfiles are plain text. The one wrinkle is name/version format.

---

## 1. Manifests to parse

Parse `go.sum` (preferred) or fall back to `go.mod`.

### `go.sum`
```
github.com/gin-gonic/gin v1.9.0 h1:...
github.com/gin-gonic/gin v1.9.0/go.mod h1:...
golang.org/x/sys v0.5.0 h1:...
```
Each line is `<module-path> <version>[/go.mod] <hash>`.
- The **module path is the name** OSV expects (full path, e.g.
  `github.com/gin-gonic/gin`), not just the last segment.
- Collapse the `/go.mod` and content-hash lines: dedupe on `path@version`.
- **Strip `+incompatible`** and pseudo-version suffixes only if OSV rejects them —
  otherwise pass the version through verbatim (OSV understands Go pseudo-versions
  like `v0.0.0-20230101000000-abcdef123456`).

### `go.mod` (fallback)
```
require (
    github.com/gin-gonic/gin v1.9.0
    golang.org/x/sys v0.5.0 // indirect
)
```
Parse `require` blocks and single-line `require x v1.2.3`. `go.mod` lists direct +
indirect requirements but is less complete than `go.sum` for the full graph; prefer
`go.sum` when both exist.

### Version format
OSV expects Go versions **with the leading `v`** (`v1.9.0`). Keep it — do not strip.

---

## 2. version-conflict note

Go modules enforce a single version per module in a build (minimal version
selection), so *within one `go.sum`* you rarely see true duplicates — except across
**major-version module paths** (`.../v2`, `.../v3`), which Go treats as *different
modules*. Surface those: `github.com/foo/bar` and `github.com/foo/bar/v2` coexisting
is the Go analog of a version conflict. Detect by stripping a trailing `/vN` when
grouping.

---

## 3. Collision analysis analog

### `go-global-state`
| Target class | Example | Hazard |
|---|---|---|
| `init()` side effects | package registers into a global on import | order-dependent, invisible |
| `http.DefaultServeMux` | `http.HandleFunc("/x", …)` | two libs claim the same route |
| `flag` package | `flag.String("v", …)` at package scope | duplicate flag → panic at startup |
| Global var mutation | writes to exported package globals | shared process state |
| `expvar` / `prometheus` default registry | `prometheus.MustRegister(...)` | duplicate metric → panic |

The `flag` and default-registry cases are standout: duplicate registration **panics
at runtime**, so two deps doing it is a real, findable bug.

### `go-hooks` (event-listener analog)
| Target class | API |
|---|---|
| Signal notify | `signal.Notify(ch, syscall.SIGTERM)` |
| Finalizers | `runtime.SetFinalizer(...)` |
| `atexit`-style | (no stdlib; via libs) |

### Extraction mechanism
Go source for a dependency lives in the module cache
(`$GOPATH/pkg/mod/<path>@<version>/`), not next to `go.sum`. Same resolution problem
as Rust. Options:

1. **osv + version-conflict only** (v1). Strong value on its own.
2. Later: `tree-sitter-go` (WASM) on the Node side + module-cache resolution, or shell
   out to `go/parser` via a bundled Go helper. Defer.

Recommendation: v1 is **osv + version-conflict**; collision scanner is a stretch goal.

---

## 4. Test lab

`test/build-go-lab.ts`:
- **osv**: pin modules with known Go advisories (e.g. an old `github.com/gin-gonic/gin`
  or `golang.org/x/net` with a GO-xxxx-xxxx advisory).
- **version-conflict**: include `github.com/foo/bar v1.x` and
  `github.com/foo/bar/v2 v2.x` to exercise the major-version-path case.
- **collision**: deferred.

---

## 5. Open questions

- Use `go.sum` (full graph, includes test deps) or `go.mod` (declared deps)? Lean
  `go.sum` for OSV completeness, but it inflates the count with transitive/test deps —
  maybe flag which is which.
- Resolve the module cache for source scanning, or leave Go as osv+version-conflict?
