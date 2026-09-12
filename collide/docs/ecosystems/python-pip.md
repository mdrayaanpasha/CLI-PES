# Python (pip / PyPI) — support plan

> Prerequisite: the shared plumbing in [`README.md`](./README.md) (ecosystem field,
> parser registry, ecosystem-aware OSV + version-conflict).
>
> OSV ecosystem string: **`PyPI`**

Python is the highest-priority target. OSV has excellent PyPI coverage, the common
lockfiles are trivial to parse, and duplicate-version detection is genuinely useful
in Python's flat `site-packages` world.

---

## 1. Manifests to parse

Handle three, in priority order. All map to one parser (`parsers/pip.ts`) matched by
filename.

| File | Format | Pinned? | Notes |
|---|---|---|---|
| `poetry.lock` | TOML | ✅ exact | Best signal — fully resolved graph with hashes |
| `Pipfile.lock` | JSON | ✅ exact | `default` + `develop` sections, `version` like `"==1.2.3"` |
| `requirements.txt` | line-based | ⚠️ only if `==` | Ubiquitous but often unpinned |

### `poetry.lock` (preferred)
```toml
[[package]]
name = "requests"
version = "2.31.0"
```
Parse every `[[package]]` table → `{ name, version, ecosystem: "PyPI" }`.
A TOML parser is needed (`@iarna/toml` or `smol-toml`); note this adds a dep.

### `Pipfile.lock`
```json
{ "default": { "requests": { "version": "==2.31.0" } },
  "develop": { "pytest":  { "version": "==7.4.0"  } } }
```
Iterate `default` + `develop`; strip the leading `==` from `version`.

### `requirements.txt`
```
requests==2.31.0
flask>=2.0            # SKIP — not exactly pinned
-e ./local            # SKIP — editable/local
git+https://…         # SKIP — VCS
django == 4.2.1       # accept, tolerate whitespace
```
Only rows matching `^\s*([A-Za-z0-9._-]+)\s*==\s*([^\s;#]+)` are usable — a version
range can't be sent to OSV as a single version. Log how many rows were skipped so a
mostly-unpinned file doesn't silently look "clean". Strip inline `# comments`,
environment markers (`; python_version < "3.9"`), and extras (`requests[security]`
→ `requests`).

---

## 2. OSV name normalization

PyPI names are **case-insensitive** and treat `-`, `_`, `.` as equivalent (PEP 503).
OSV expects the normalized form: lowercase, runs of `[-_.]` collapsed to a single `-`.

```
Flask         → flask
zope.interface→ zope-interface
ruamel_yaml   → ruamel-yaml
```

Normalize in the parser so both `osv` and `version-conflict` see canonical names.
(Without this, `Flask==2.0` vs `flask==3.0` would look like *different* packages and
the version conflict would be missed.)

---

## 3. Collision analysis analog

The JS scanners flag shared-global writes and duplicate event-listener registrations.
Python's process-wide equivalents:

### `python-global-state` — shared mutable global / builtin state
Flag when **2+ dependencies** touch the same target:

| Target class | Example | Why it collides |
|---|---|---|
| Builtin/stdlib monkeypatch | `socket.socket = MyPatched` | last import wins, order-dependent |
| `sys.modules` surgery | `sys.modules["json"] = ujson` | swaps a module for the whole process |
| `os.environ` writes | `os.environ["TZ"] = ...` | process-global config |
| gevent/eventlet monkeypatch | `gevent.monkey.patch_all()` | rewrites stdlib for everyone |
| Global registries | `warnings.filterwarnings(...)` | shared filter stack |

### `python-hooks` — process-wide handler registration (event-listener analog)
| Target class | API |
|---|---|
| Signal handlers | `signal.signal(signal.SIGTERM, …)` |
| Exit handlers | `atexit.register(…)` |
| Import hooks | `sys.meta_path.append(…)`, `sys.path_hooks` |
| Excepthook / audit | `sys.excepthook = …`, `sys.addaudithook(…)` |
| Warning filters | `warnings.simplefilter(…)` |

Two packages both trapping `SIGTERM`, or both setting `sys.excepthook`, is the same
"last one wins" hazard the JS event-listener scanner catches.

### Extraction mechanism
Python's stdlib `ast` module is the right tool, but it runs in **Python, not Node**.
Options, cheapest first:

1. **Regex/heuristic pass over `.py` files** (no Python runtime). Fast, no deps,
   some false positives. Good enough for a v1 — grep for `signal.signal(`,
   `atexit.register(`, `sys.modules[`, `os.environ[`, assignment to dotted stdlib
   names. Reuse the existing `source-locator` pattern but for `.py`.
2. **Shell out to a bundled Python** (`python3 -c "import ast; …"`) that emits JSON
   profiles. Accurate, but requires Python on PATH — degrade to option 1 if absent.
3. **A JS-side Python parser** (e.g. `tree-sitter-python` via WASM). Accurate, no
   Python runtime, heavier dep. Best long-term.

Recommendation: ship **osv + version-conflict** first (no source analysis needed),
then add `python-global-state`/`python-hooks` via option 1, upgrading to option 3 if
false positives become a problem.

### Locating source
pip installs flat into `site-packages/<pkg>/` (or a single-file `<pkg>.py`). The
lockfile doesn't record install paths the way `package-lock.json` does, so a source
analyzer must resolve `sourcePath` by looking next to the manifest
(`.venv/lib/python*/site-packages/`) — record this in the parser when a venv is
discoverable, else leave `sourcePath` undefined and skip source scanners for that pkg.

---

## 4. `ResolvedPackage` output shape

```ts
{ name: "requests", version: "2.31.0", ecosystem: "PyPI",
  sourcePath: "/proj/.venv/lib/python3.11/site-packages/requests" }  // if resolvable
```

---

## 5. Test lab

`test/build-pip-lab.ts`, mirroring `build-vuln-lab.ts`:

- **osv**: pin known-vulnerable releases — e.g. `Django==2.2.0`, `requests==2.19.1`,
  `PyYAML==5.1`, `Jinja2==2.10` (all have well-known CVEs on OSV).
- **version-conflict**: emit the same package twice at different versions across a
  `poetry.lock` + a nested requirement (or two lock sources).
- **collision**: two synthetic packages that both `signal.signal(SIGTERM, …)` and
  both monkeypatch `socket.socket`.

Gate OSV assertions on network exactly like the npm lab.

---

## 6. Open questions

- TOML parser dependency — acceptable, or hand-roll the tiny subset `poetry.lock` uses?
- Should an unpinned `requirements.txt` (all ranges, nothing to scan) be a hard error
  or a warning + empty result? (Lean: warning.)
- Resolve versions for ranges via the installed `site-packages` metadata when a venv
  is present, to rescue unpinned files?
