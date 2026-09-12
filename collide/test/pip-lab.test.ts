// test/pip-lab.test.ts
// Test environment for the Python (pip) pipeline. Everything here is offline and
// deterministic: it builds a synthetic requirements.txt + fake venv lab
// (test/build-pip-lab.ts) and exercises the pip parser, PyPI name
// normalization, the version-conflict scanner, the heuristic source extractor,
// the collision scanners, and the CLI end-to-end via `--only=version-conflict`
// (which needs no network).
//
// The `osv` scanner requires network access, so it is not asserted here.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import { buildPipLab } from "./build-pip-lab";
import {
  normalizePyName,
  parsePipManifest,
  parseRequirements,
  parsePoetryLock,
  parsePipfileLock,
} from "../src/core/pip-manifest";
import { versionConflictScanner } from "../src/scanners/version-conflict";
import { extractPyProfile } from "../src/scanners/py-profile-extractor";
import { pyGlobalStateScanner, pyHooksScanner } from "../src/scanners/py-collision";
import type { Finding } from "../src/core/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.ts");

let ROOT: string;
let REQ: string;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "collide-piplab-"));
  REQ = buildPipLab(ROOT);
});
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("pip sandbox (build-pip-lab)", () => {
  test("writes requirements.txt with pinned + skippable rows", () => {
    const req = readFileSync(REQ, "utf8");
    assert.match(req, /Django==2\.2\.0/);
    assert.match(req, /flask>=2\.0/); // an unpinned row (will be skipped)
    assert.match(req, /-e \.\/local-editable/);
  });
});

describe("normalizePyName (PEP 503)", () => {
  test("lowercases and collapses -_. to a single -", () => {
    assert.equal(normalizePyName("Flask"), "flask");
    assert.equal(normalizePyName("zope.interface"), "zope-interface");
    assert.equal(normalizePyName("ruamel_yaml"), "ruamel-yaml");
    assert.equal(normalizePyName("Foo__Bar.._baz"), "foo-bar-baz");
  });
});

describe("parseRequirements", () => {
  test("keeps only ==-pinned rows and counts the rest as skipped", () => {
    const res = parseRequirements(
      [
        "requests==2.31.0",
        "flask>=2.0",
        "-e ./local",
        "git+https://example.com/x.git#egg=x",
        'django == 4.2.1 ; python_version < "3.9"',
        "requests[security]==2.31.0", // dup of requests after extras stripped
        "# a comment",
      ].join("\n"),
    );
    const names = res.packages.map((p) => `${p.name}@${p.version}`);
    assert.ok(names.includes("requests@2.31.0"));
    assert.ok(names.includes("django@4.2.1")); // whitespace + marker tolerated
    // flask (range), -e, git+ are all skipped
    assert.ok(res.skipped >= 2, `expected skips, got ${res.skipped}`);
    // extras-stripped requests dedupes against the earlier pin
    assert.equal(names.filter((n) => n === "requests@2.31.0").length, 1);
  });
});

describe("parsePoetryLock", () => {
  test("extracts name/version from each [[package]] table", () => {
    const pkgs = parsePoetryLock(
      [
        "[[package]]",
        'name = "Requests"',
        'version = "2.31.0"',
        'description = "..."',
        "",
        "[[package]]",
        'name = "zope.interface"',
        'version = "6.0"',
        "",
        "[metadata]",
        'lock-version = "2.0"',
      ].join("\n"),
    );
    assert.equal(pkgs.length, 2);
    assert.ok(pkgs.some((p) => p.name === "requests" && p.version === "2.31.0"));
    assert.ok(pkgs.some((p) => p.name === "zope-interface" && p.version === "6.0"));
  });
});

describe("parsePipfileLock", () => {
  test("reads default + develop, strips == and normalizes names", () => {
    const pkgs = parsePipfileLock(
      JSON.stringify({
        default: { Requests: { version: "==2.31.0" } },
        develop: { pytest: { version: "==7.4.0" } },
      }),
    );
    assert.equal(pkgs.length, 2);
    assert.ok(pkgs.some((p) => p.name === "requests" && p.version === "2.31.0"));
    assert.ok(pkgs.some((p) => p.name === "pytest" && p.version === "7.4.0"));
  });
});

describe("parsePipManifest (lab requirements.txt)", () => {
  test("normalizes Django/Jinja2 and resolves venv source paths", () => {
    const pkgs = parsePipManifest(REQ);
    // Django → django, Jinja2 → jinja2
    assert.ok(pkgs.some((p) => p.name === "django" && p.version === "2.2.0"));
    // both jinja2 pins present (2.10 and 3.0.0) after normalization
    const jinja = pkgs.filter((p) => p.name === "jinja2");
    assert.equal(jinja.length, 2);
    // collision packages resolved to source in the fake venv
    const alpha = pkgs.find((p) => p.name === "collide-alpha")!;
    assert.ok(alpha.sourcePath, "expected sourcePath resolved from .venv");
  });
});

describe("versionConflictScanner (reused for Python)", () => {
  test("flags the duplicate jinja2 versions", async () => {
    const pkgs = parsePipManifest(REQ);
    const findings = await versionConflictScanner.scan(pkgs);
    const jinja = findings.find((f) => f.target === "jinja2");
    assert.ok(jinja, "expected a jinja2 version conflict");
    assert.equal(jinja!.owners.length, 2);
  });

  test("does not flag clean single-version packages", async () => {
    const pkgs = parsePipManifest(REQ);
    const findings = await versionConflictScanner.scan(pkgs);
    assert.ok(!findings.some((f) => f.target === "certifi"));
    assert.ok(!findings.some((f) => f.target === "django"));
  });
});

describe("extractPyProfile (heuristic source scan)", () => {
  test("extracts monkeypatch / environ writes and signal / atexit hooks", () => {
    const profile = extractPyProfile(`import os, signal, socket, atexit, sys
socket.socket = MyPatched
os.environ["TZ"] = "UTC"
sys.modules["json"] = ujson
signal.signal(signal.SIGTERM, handler)
atexit.register(cleanup)
sys.excepthook = my_hook
`);
    assert.ok(profile.writes.includes("monkeypatch:socket.socket"));
    assert.ok(profile.writes.includes("environ:TZ"));
    assert.ok(profile.writes.includes("sys-modules:json"));
    assert.ok(profile.listeners.includes("signal:SIGTERM"));
    assert.ok(profile.listeners.includes("atexit:register"));
    assert.ok(profile.listeners.includes("excepthook:sys.excepthook"));
  });

  test("ignores patterns that only appear in comments/docstrings", () => {
    const profile = extractPyProfile(`"""
signal.signal(signal.SIGTERM, ghost)
"""
# atexit.register(ghost)
`);
    assert.deepEqual(profile.writes, []);
    assert.deepEqual(profile.listeners, []);
  });
});

describe("pyGlobalStateScanner (Python source collisions)", () => {
  test("flags socket monkeypatch + TZ written by 2+ packages", async () => {
    const pkgs = parsePipManifest(REQ);
    const findings = await pyGlobalStateScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));

    for (const target of ["monkeypatch:socket.socket", "environ:TZ"]) {
      const f = byTarget.get(target);
      assert.ok(f, `expected a collision on ${target}`);
      assert.equal(f!.owners.length, 2);
      assert.equal(f!.severity, "high");
    }
  });
});

describe("pyHooksScanner (Python hook collisions)", () => {
  test("flags SIGTERM + atexit registered by 2+ packages", async () => {
    const pkgs = parsePipManifest(REQ);
    const findings = await pyHooksScanner.scan(pkgs);
    const byTarget = new Map(findings.map((f) => [f.target, f]));
    assert.ok(byTarget.get("signal:SIGTERM"), "expected signal:SIGTERM collision");
    assert.ok(byTarget.get("atexit:register"), "expected atexit:register collision");
    assert.equal(byTarget.get("signal:SIGTERM")!.owners.length, 2);
  });
});

describe("collide scan (Python CLI e2e, offline)", () => {
  function runCli(args: string[]): string {
    return execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, COLLIDE_DB_PATH: join(ROOT, "pip-cli-cache.db") },
    });
  }

  test("--only=version-conflict --format=json reports the jinja2 conflict", () => {
    const out = runCli(["scan", REQ, "--only=version-conflict", "--format=json"]);
    const parsed = JSON.parse(out) as { findings?: Finding[] } | Finding[];
    const findings = Array.isArray(parsed) ? parsed : parsed.findings ?? [];
    const jinja = findings.find((f) => f.target === "jinja2");
    assert.ok(jinja, `expected jinja2 conflict in: ${out}`);
    assert.equal(jinja!.scanner, "version-conflict");
  });
});
