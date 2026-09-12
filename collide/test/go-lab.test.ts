// test/go-lab.test.ts
// Test environment for the Go module pipeline. Everything here is offline and
// deterministic: it builds a synthetic go.mod/go.sum lab (test/build-go-lab.ts)
// and exercises the Go parser, the major-version-path conflict scanner, and the
// CLI end-to-end via `--only=version-conflict` (which needs no network).
//
// The `osv` scanner requires network access, so it is not asserted here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { buildGoLab, goModCachePath } from "./build-go-lab";
import { parseGoManifest, parseGoSum, parseGoMod } from "../src/core/go-manifest";
import { goVersionConflictScanner } from "../src/scanners/go-version-conflict";
import {
  goGlobalStateScanner,
  goEventListenerScanner,
} from "../src/scanners/go-collision";
import { extractGoProfile } from "../src/scanners/go-profile-extractor";
import type { Finding } from "../src/core/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.ts");

let ROOT: string;
let GO_SUM: string;
let MODCACHE: string;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "collide-golab-"));
  GO_SUM = buildGoLab(ROOT);
  MODCACHE = goModCachePath(ROOT);
  // point the source scanners at the lab's fake module cache
  process.env.COLLIDE_GOMODCACHE = MODCACHE;
});
after(() => {
  delete process.env.COLLIDE_GOMODCACHE;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("go sandbox (build-go-lab)", () => {
  test("writes both go.mod and go.sum", () => {
    const sum = readFileSync(GO_SUM, "utf8");
    const mod = readFileSync(join(ROOT, "go.mod"), "utf8");
    assert.match(sum, /github\.com\/gin-gonic\/gin v1\.6\.3/);
    assert.match(mod, /^module example\.com\/collide\/golab/m);
    assert.match(mod, /require \(/);
  });
});

describe("parseGoSum", () => {
  test("dedupes the /go.mod hash line onto one path@version each", () => {
    const pkgs = parseGoManifest(GO_SUM);
    // 13 lab modules → 13 resolved packages (not 26, despite 2 lines apiece)
    assert.equal(pkgs.length, 13);
    const gin = pkgs.find((p) => p.name === "github.com/gin-gonic/gin")!;
    assert.equal(gin.version, "v1.6.3"); // leading `v` kept
  });

  test("keeps full module path as the name and preserves version suffixes", () => {
    const pkgs = parseGoSum(
      [
        "github.com/gin-gonic/gin v1.9.0 h1:abc=",
        "github.com/gin-gonic/gin v1.9.0/go.mod h1:abc=",
        "golang.org/x/net v0.0.0-20210505024714-0287a6fb4125 h1:def=",
        "github.com/dgrijalva/jwt-go v3.2.0+incompatible h1:ghi=",
      ].join("\n"),
    );
    assert.equal(pkgs.length, 3);
    // full path, not last segment
    assert.ok(pkgs.some((p) => p.name === "golang.org/x/net"));
    // pseudo-version and +incompatible pass through verbatim
    assert.ok(
      pkgs.some((p) => p.version === "v0.0.0-20210505024714-0287a6fb4125"),
    );
    assert.ok(pkgs.some((p) => p.version === "v3.2.0+incompatible"));
  });
});

describe("parseGoMod", () => {
  test("parses block + single-line require and drops // indirect comments", () => {
    const pkgs = parseGoMod(
      [
        "module example.com/app",
        "go 1.21",
        "require github.com/foo/bar v1.2.3",
        "require (",
        "\tgithub.com/gin-gonic/gin v1.9.0",
        "\tgolang.org/x/sys v0.5.0 // indirect",
        ")",
      ].join("\n"),
    );
    assert.equal(pkgs.length, 3);
    const sys = pkgs.find((p) => p.name === "golang.org/x/sys")!;
    assert.equal(sys.version, "v0.5.0"); // comment stripped, version intact
  });
});

describe("goVersionConflictScanner", () => {
  test("flags major-version-path modules as a single 3-way conflict", async () => {
    const pkgs = parseGoManifest(GO_SUM);
    const findings = await goVersionConflictScanner.scan(pkgs);

    const bar = findings.find((f) => f.target === "github.com/foo/bar");
    assert.ok(bar, "expected a conflict grouped under the base module path");
    assert.equal(bar!.owners.length, 3); // v1.4.0, v2.1.0, v3.0.1
    assert.match(bar!.message, /major versions/);
    assert.ok(bar!.owners.includes("github.com/foo/bar/v2@v2.1.0"));
  });

  test("does not flag clean single-version modules", async () => {
    const pkgs = parseGoManifest(GO_SUM);
    const findings = await goVersionConflictScanner.scan(pkgs);
    const targets = findings.map((f) => f.target);
    assert.ok(!targets.includes("github.com/stretchr/testify"));
    assert.ok(!targets.includes("golang.org/x/sys"));
  });
});

describe("extractGoProfile (heuristic source scan)", () => {
  test("extracts flag / route / expvar writes and signal / finalizer hooks", () => {
    const profile = extractGoProfile(`package x
import ("flag"; "net/http"; "expvar"; "os/signal"; "syscall"; "runtime")
var p = flag.String("port", "80", "")
func init() {
	http.HandleFunc("/health", nil)
	expvar.Publish("uptime", nil)
	signal.Notify(nil, syscall.SIGTERM)
	runtime.SetFinalizer(nil, nil)
}
`);
    assert.ok(profile.writes.includes("flag:port"));
    assert.ok(profile.writes.includes("http-route:/health"));
    assert.ok(profile.writes.includes("expvar:uptime"));
    assert.ok(profile.listeners.includes("signal:SIGTERM"));
    assert.ok(profile.listeners.includes("runtime:SetFinalizer"));
  });

  test("ignores patterns that only appear in comments", () => {
    const profile = extractGoProfile(`package x
// flag.String("ghost", "", "") should not be picked up
/* http.HandleFunc("/ghost", nil) */
`);
    assert.deepEqual(profile.writes, []);
    assert.deepEqual(profile.listeners, []);
  });
});

describe("goGlobalStateScanner (Go source collisions)", () => {
  test("flags flag / route / expvar registered by 2+ modules", async () => {
    const pkgs = parseGoManifest(GO_SUM);
    const findings = await goGlobalStateScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));

    for (const target of ["flag:port", "http-route:/health", "expvar:uptime"]) {
      const f = byTarget.get(target);
      assert.ok(f, `expected a collision on ${target}`);
      assert.equal(f!.owners.length, 2);
      assert.equal(f!.severity, "high");
    }
  });
});

describe("goEventListenerScanner (Go hooks collisions)", () => {
  test("flags SIGTERM registered by 2+ modules", async () => {
    const pkgs = parseGoManifest(GO_SUM);
    const findings = await goEventListenerScanner.scan(pkgs);
    const sig = findings.find((f) => f.target === "signal:SIGTERM");
    assert.ok(sig, "expected a signal:SIGTERM collision (probe + stats)");
    assert.equal(sig!.owners.length, 2);
  });
});

describe("collide scan (Go CLI e2e, offline)", () => {
  function runCli(args: string[]): string {
    return execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, COLLIDE_DB_PATH: join(ROOT, "go-cli-cache.db") },
    });
  }

  test("--only=version-conflict --format=json reports the major-path conflict", () => {
    const out = runCli([
      "scan",
      GO_SUM,
      "--only=version-conflict",
      "--format=json",
    ]);
    // JSON output; the report envelope carries findings — locate the array.
    const parsed = JSON.parse(out) as { findings?: Finding[] } | Finding[];
    const findings = Array.isArray(parsed) ? parsed : parsed.findings ?? [];
    const bar = findings.find((f) => f.target === "github.com/foo/bar");
    assert.ok(bar, `expected github.com/foo/bar conflict in: ${out}`);
    assert.equal(bar!.scanner, "version-conflict");
  });
});
