# Ruby (Bundler / RubyGems) — support plan

> Prerequisite: shared plumbing in [`README.md`](./README.md).
>
> OSV ecosystem string: **`RubyGems`**

Ruby is a natural fit: `Gemfile.lock` is fully resolved and pinned, OSV mirrors the
`ruby-advisory-db`, and Ruby's "open classes" culture makes the global-state analog
especially relevant.

---

## 1. Manifest to parse

Only `Gemfile.lock`. It's a bespoke text format, not YAML/JSON, but the section we
need is regular:

```
GEM
  remote: https://rubygems.org/
  specs:
    actionpack (7.0.4)
      actionview (= 7.0.4)
    nokogiri (1.13.9)
    rack (2.2.4)
```

Parse the `specs:` block under `GEM`. Each gem is a line indented **4 spaces**:
`^\s{4}([a-zA-Z0-9._-]+) \(([^)]+)\)$` → `{ name, version, ecosystem: "RubyGems" }`.
Lines indented 6 spaces are that gem's dependencies — **skip them** (they're
constraints, not resolved installs). Ignore `PLATFORMS`, `DEPENDENCIES`,
`BUNDLED WITH`, and non-`GEM` sources (`GIT`, `PATH`) for OSV (still count for
version-conflict if a version is present).

Gem names are already canonical (lowercase, `-`/`_`); no normalization needed.

---

## 2. Collision analysis analog

Ruby's dynamic nature makes this the richest non-JS target.

### `ruby-global-state` — monkeypatching & global state
| Target class | Example | Hazard |
|---|---|---|
| Core-class reopening | `class String; def blank?; …; end; end` | two gems redefine same method |
| `refine` / `prepend` | module prepended to `Array` | ordering-dependent |
| Global vars | `$stdout = …`, `$LOAD_PATH <<` | process-global |
| Constant redefinition | reassigning a top-level constant | last load wins |

The core-class-reopening case is the direct analog of JS prototype patching: two gems
both defining `String#blank?` collide silently.

### `ruby-hooks` (event-listener analog)
| Target class | API |
|---|---|
| Exit handlers | `at_exit { … }` |
| Signal traps | `Signal.trap("TERM") { … }` |
| `TracePoint` | `TracePoint.new(...).enable` |
| `ObjectSpace` finalizers | `ObjectSpace.define_finalizer(...)` |

Two gems both `Signal.trap("TERM")` — last trap wins — is exactly the event-listener
"last registration wins" hazard.

### Extraction mechanism
Gem source lives in `.../gems/<name>-<version>/lib/`, resolvable relative to the
bundle when `bundle install --path` or a standard gem home is discoverable. Options:

1. **osv + version-conflict only** (v1).
2. Ruby has no bundled JS parser; use `tree-sitter-ruby` (WASM) on the Node side, or
   shell out to `ruby -e "require 'ripper'; …"` if Ruby is on PATH (degrade if not).
   The heuristic-regex approach (grep for `Signal.trap`, `at_exit`, `class String`)
   is a cheap first cut.

Recommendation: v1 **osv + version-conflict**; add `ruby-global-state`/`ruby-hooks`
via regex heuristics later, since the monkeypatch collisions are compelling.

---

## 3. Test lab

`test/build-bundler-lab.ts`:
- **osv**: pin gems with known advisories (e.g. an old `nokogiri`, `rack`, or
  `actionpack` version — all have RubyGems advisories in OSV).
- **version-conflict**: normally Bundler resolves to one version per gem, so simulate
  by combining two lock sources or a `GIT` + `GEM` copy of the same gem at different
  versions.
- **collision**: two synthetic gems that both `Signal.trap("TERM")` and both reopen
  `String` to define the same method.

---

## 4. Open questions

- `Gemfile.lock` pins one version per gem, so version-conflict rarely fires from a
  single lockfile — is it worth surfacing across multiple bundles / a monorepo?
- Ruby runtime dependency for accurate parsing vs. regex heuristics — which default?
