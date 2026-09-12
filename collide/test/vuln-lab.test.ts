// test/vuln-lab.test.ts
// Deterministic (no-network) tests for the vuln-lab fixture: verify the three
// LOCAL scanners fire on it. The osv scanner is excluded here because it needs
// network access (it's tested separately with a mocked fetch in osv.test.ts).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { buildVulnLab } from "./build-vuln-lab";
import { parseLockfile } from "../src/core/lockfile";
import { runScans } from "../src/core/scanner";
import { globalStateScanner } from "../src/scanners/global-state";
import { eventListenerScanner } from "../src/scanners/event-listeners";
import { versionConflictScanner } from "../src/scanners/version-conflict";

let ROOT: string;
let LOCKFILE: string;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "collide-vlab-"));
  LOCKFILE = buildVulnLab(ROOT);
  process.env.COLLIDE_DB_PATH = join(ROOT, "vlab-cache.db");
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

describe("vuln-lab trips the local scanners", () => {
  test("all three local scanners produce findings", async () => {
    const pkgs = parseLockfile(LOCKFILE);
    const findings = await runScans(pkgs, [
      globalStateScanner,
      eventListenerScanner,
      versionConflictScanner,
    ]);

    const byScanner = (name: string) => findings.filter((f) => f.scanner === name);

    // global-state: shimmy-a & shimmy-b both patch Array.prototype.flat
    const gs = byScanner("global-state");
    assert.equal(gs.length, 1);
    assert.equal(gs[0].target, "Array.prototype.flat");
    assert.deepEqual(gs[0].owners.sort(), ["shimmy-a", "shimmy-b"]);

    // event-listeners: shimmy-a & listen-x both bind window:resize
    const el = byScanner("event-listeners");
    assert.equal(el.length, 1);
    assert.equal(el[0].target, "window:resize");
    assert.deepEqual(el[0].owners.sort(), ["listen-x", "shimmy-a"]);

    // version-conflict: lodash at 4.17.11 and 3.10.1
    const vc = byScanner("version-conflict");
    assert.equal(vc.length, 1);
    assert.equal(vc[0].target, "lodash");
    assert.equal(vc[0].owners.length, 2);
  });
});
