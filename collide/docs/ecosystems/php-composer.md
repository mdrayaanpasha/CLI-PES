# PHP (Composer / Packagist) — support plan

> Prerequisite: shared plumbing in [`README.md`](./README.md).
>
> OSV ecosystem string: **`Packagist`**

PHP is the easiest of the "stretch" ecosystems: `composer.lock` is JSON, fully
resolved and pinned, and OSV mirrors the FriendsOfPHP security advisories.

---

## 1. Manifest to parse

Only `composer.lock` (JSON).

```json
{
  "packages": [
    { "name": "symfony/console", "version": "v6.3.4" },
    { "name": "monolog/monolog",  "version": "3.4.0" }
  ],
  "packages-dev": [
    { "name": "phpunit/phpunit", "version": "10.3.2" }
  ]
}
```

Iterate `packages` + `packages-dev`. Each entry → `{ name, version, ecosystem:
"Packagist" }`.

- Names are `vendor/package` (e.g. `symfony/console`) — **keep the full slug**, that's
  what OSV/Packagist expects. Lowercase it (Packagist names are case-insensitive).
- **Strip a leading `v`** from versions if OSV rejects it (`v6.3.4` → `6.3.4`); test
  both — Packagist advisories are usually keyed without the `v`.

No further normalization.

---

## 2. Collision analysis analog

PHP's global namespace and process-global config make these relevant, but static
extraction is harder (autoloaded classes, runtime `ini_set`).

### `php-global-state`
| Target class | Example | Hazard |
|---|---|---|
| Global function definition | `function dd() {…}` in the root namespace | two packages define `dd()` → fatal error |
| `ini_set` | `ini_set('memory_limit', …)` | process-global config |
| Superglobal mutation | writes to `$GLOBALS[...]` | shared state |
| Constant definition | `define('X', …)` | redefinition warning / last wins |

The global-function-collision case is a real fatal error in PHP (can't redeclare a
function), so two packages defining the same root-namespace helper is high-value.

### `php-hooks` (event-listener analog)
| Target class | API |
|---|---|
| Shutdown functions | `register_shutdown_function(...)` |
| Error/exception handlers | `set_error_handler(...)`, `set_exception_handler(...)` |
| Autoloaders | `spl_autoload_register(...)` |
| Signal handlers (pcntl) | `pcntl_signal(SIGTERM, …)` |

`set_error_handler` / `set_exception_handler` are "last registration wins" — two
packages fighting over them is the event-listener hazard exactly.

### Extraction mechanism
Vendor source lives in `vendor/<vendor>/<package>/`, resolvable relative to
`composer.lock`. So unlike Rust/Go, **source is right there** — a heuristic pass over
`vendor/**/*.php` is feasible without a package cache lookup. Options:

1. **osv + version-conflict only** (v1).
2. Regex heuristics over `vendor/**/*.php` (grep for `set_error_handler(`,
   `register_shutdown_function(`, root-namespace `function <name>(`, `define(`) — cheap
   and viable since source is local.
3. `tree-sitter-php` (WASM) for accuracy later.

Recommendation: v1 **osv + version-conflict**, then heuristic collision scanning is
attractive because vendor source is co-located with the lockfile.

---

## 3. Test lab

`test/build-composer-lab.ts`:
- **osv**: pin packages with known FriendsOfPHP advisories (e.g. an old
  `symfony/http-kernel`, `guzzlehttp/guzzle`, or `monolog/monolog`).
- **version-conflict**: Composer resolves one version per package, so simulate a
  duplicate by combining two lock sources or a nested vendor copy.
- **collision**: two synthetic packages that both `set_error_handler(...)` and both
  define a root-namespace `function dump()`.

---

## 4. Open questions

- Version `v`-prefix handling for OSV — confirm against a live Packagist advisory.
- version-conflict rarely fires from one `composer.lock`; scope it to
  monorepo/multi-lock scenarios?
