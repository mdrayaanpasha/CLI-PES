// test/build-go-lab.ts
// Builds a deterministic synthetic Go module project (go.mod + go.sum) whose
// contents we control exactly, so the Go pipeline's output is predictable:
//
//   • osv              — real module paths pinned at versions with known Go
//                        advisories (github.com/gin-gonic/gin, golang.org/x/net,
//                        golang.org/x/crypto, github.com/dgrijalva/jwt-go).
//   • version-conflict — github.com/foo/bar v1.x AND github.com/foo/bar/v2 v2.x
//                        coexisting as separate modules (the Go major-version
//                        conflict), plus a same-path duplicate in go.mod terms.
//
// OSV needs only module-path@version (it queries osv.dev over the network), so
// no source files are written — Go source lives in the module cache, and the Go
// path is osv + version-conflict only. See docs/ecosystems/go-modules.md §4.
//
// NOTE: the `osv` scanner requires network access to return findings; the
// version-conflict scanner is fully offline and deterministic.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GoLabModule {
  /** full module path — the name OSV expects */
  path: string;
  /** version, leading `v` kept (v1.9.0, or a pseudo-version) */
  version: string;
  /** why it's in the lab (dev reference) */
  note?: string;
  /** true for a direct require in go.mod; others are marked // indirect */
  direct?: boolean;
  /** synthetic .go source files (filename → contents) written into the fake
   *  module cache; drives the global-state / event-listeners scanners */
  source?: Record<string, string>;
}

export const GO_LAB_MODULES: GoLabModule[] = [
  // ── real, known-vulnerable (OSV) ──
  {
    path: "github.com/gin-gonic/gin",
    version: "v1.6.3",
    note: "GHSA/GO advisories in old gin (e.g. header/redirect issues)",
    direct: true,
  },
  {
    path: "golang.org/x/net",
    version: "v0.0.0-20210505024714-0287a6fb4125",
    note: "pseudo-version; older x/net has multiple GO advisories",
    direct: true,
  },
  {
    path: "golang.org/x/crypto",
    version: "v0.0.0-20200622213623-75b288015ac9",
    note: "older x/crypto ssh advisories",
  },
  {
    path: "github.com/dgrijalva/jwt-go",
    version: "v3.2.0+incompatible",
    note: "+incompatible suffix; jwt-go has a well-known auth-bypass advisory",
    direct: true,
  },

  // ── version-conflict: major-version-path pair (the Go analog) ──
  {
    path: "github.com/foo/bar",
    version: "v1.4.0",
    note: "major-version conflict: v1 module path",
    direct: true,
  },
  {
    path: "github.com/foo/bar/v2",
    version: "v2.1.0",
    note: "major-version conflict: v2 module path (separate module)",
    direct: true,
  },
  {
    path: "github.com/foo/bar/v3",
    version: "v3.0.1",
    note: "major-version conflict: v3 module path → 3-way",
  },

  // ── clean transitive deps (must NOT be flagged as conflicts) ──
  {
    path: "github.com/stretchr/testify",
    version: "v1.8.4",
    note: "clean dep — single version",
  },
  {
    path: "golang.org/x/sys",
    version: "v0.5.0",
    note: "clean dep — single version",
  },

  // ── collision fixtures — carry real Go source in the fake module cache ──
  // Designed overlaps:
  //   http-route:/health → httpd + probe   (global-state)
  //   flag:port          → httpd + cfg     (global-state)
  //   expvar:uptime      → cfg + stats     (global-state)
  //   signal:SIGTERM     → probe + stats   (event-listeners)
  {
    path: "github.com/acme/httpd",
    version: "v1.0.0",
    note: "collides on /health route and --port flag",
    source: {
      "server.go": `package httpd

import (
	"flag"
	"net/http"
)

var port = flag.String("port", "8080", "listen port")

func init() {
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {})
}
`,
    },
  },
  {
    path: "github.com/acme/probe",
    version: "v0.4.0",
    note: "collides on /health route and SIGTERM",
    source: {
      "probe.go": `package probe

import (
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func Start() {
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {})
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
}
`,
    },
  },
  {
    path: "github.com/acme/cfg",
    version: "v2.3.0",
    note: "collides on --port flag and uptime expvar",
    source: {
      "cfg.go": `package cfg

import (
	"expvar"
	"flag"
)

var port = flag.String("port", "9090", "config port")

func init() {
	expvar.Publish("uptime", expvar.Func(func() interface{} { return 0 }))
}
`,
    },
  },
  {
    path: "github.com/acme/stats",
    version: "v1.1.0",
    note: "collides on uptime expvar and SIGTERM",
    source: {
      "stats.go": `package stats

import (
	"expvar"
	"os"
	"os/signal"
	"syscall"
)

func init() {
	expvar.Publish("uptime", expvar.Func(func() interface{} { return 1 }))
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGTERM)
}
`,
    },
  },
];

const GO_MODULE_PATH = "example.com/collide/golab";
const GO_VERSION = "1.21";

/** Render a go.mod from the lab modules (direct → require, others → indirect). */
function renderGoMod(modules: GoLabModule[]): string {
  const lines = [
    `module ${GO_MODULE_PATH}`,
    "",
    `go ${GO_VERSION}`,
    "",
    "require (",
    ...modules.map(
      (m) => `\t${m.path} ${m.version}${m.direct ? "" : " // indirect"}`,
    ),
    ")",
    "",
  ];
  return lines.join("\n");
}

/**
 * Render a go.sum from the lab modules. Each module contributes two lines — a
 * content hash and a `/go.mod` hash — mirroring a real go.sum. The hashes are
 * deterministic stubs (the parser only reads path + version).
 */
function renderGoSum(modules: GoLabModule[]): string {
  const lines: string[] = [];
  for (const m of modules) {
    const stub = `h1:${m.path.replace(/[^a-zA-Z0-9]/g, "")}${m.version}=`;
    lines.push(`${m.path} ${m.version} ${stub}`);
    lines.push(`${m.path} ${m.version}/go.mod ${stub}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Go escapes uppercase letters in cache paths as `!<lower>`. Lab paths are all
 *  lowercase, but mirror the real rule so the layout matches production. */
function escapeModulePath(modulePath: string): string {
  return modulePath.replace(/[A-Z]/g, (c) => "!" + c.toLowerCase());
}

/** Where the fake module cache lives for a given lab root. Point
 *  COLLIDE_GOMODCACHE at this so the source scanners resolve lab modules. */
export function goModCachePath(root: string): string {
  return join(root, "modcache");
}

/**
 * Materialize the fake Go module cache under `root/modcache`, writing each
 * module's synthetic source at `<escaped-path>@<version>/`. Returns the cache
 * dir. Modules without `source` contribute nothing (manifest-only, like the
 * real vuln modules).
 */
export function buildGoModCache(root: string): string {
  const cache = goModCachePath(root);
  for (const m of GO_LAB_MODULES) {
    if (!m.source) continue;
    const dir = join(cache, `${escapeModulePath(m.path)}@${m.version}`);
    mkdirSync(dir, { recursive: true });
    for (const [file, contents] of Object.entries(m.source)) {
      writeFileSync(join(dir, file), contents);
    }
  }
  return cache;
}

/**
 * Materialize the Go lab into `root`. Returns the path to go.sum (the preferred
 * manifest); go.mod and a fake module cache (`root/modcache`) are written
 * alongside it. Idempotent: wipes `root` first.
 */
export function buildGoLab(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  writeFileSync(join(root, "go.mod"), renderGoMod(GO_LAB_MODULES));
  const sumPath = join(root, "go.sum");
  writeFileSync(sumPath, renderGoSum(GO_LAB_MODULES));
  buildGoModCache(root);
  return sumPath;
}

// Allow running standalone: `tsx test/build-go-lab.ts <dir>` to inspect it.
if (process.argv[1] && process.argv[1].endsWith("build-go-lab.ts")) {
  const dir = process.argv[2] ?? join(process.cwd(), "test", ".go-lab");
  const p = buildGoLab(dir);
  console.log("go-lab built at", dir);
  console.log("go.sum:", p);
  console.log(
    "\nexpect: osv (gin, x/net, x/crypto, jwt-go) · " +
      "version-conflict (github.com/foo/bar v1/v2/v3 major-path)",
  );
}
