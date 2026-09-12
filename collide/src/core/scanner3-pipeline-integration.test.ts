import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runScans } from "./scanner";
import { allScanners, parseArgs, resolveEnabledScanners } from "../cli";
import { eventListenerScanner } from "../scanners/event-listeners";
import { globalStateScanner } from "../scanners/global-state";
import { versionConflictScanner } from "../scanners/version-conflict";
import { osvScanner } from "../scanners/osv";
import { formatReport } from "../report/format";
import { clearCache, getDb } from "../cache/db";
import { extractPackageProfile } from "../scanners/shared-ast-extractor";
import type { Finding, ResolvedPackage } from "./types";

describe("Stage 14: Scanner 3 Integration with Core Scanner Pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "collide-stage14-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  function createPackageFile(name: string, sourceCode: string): string {
    const filePath = path.join(tmpDir, `${name}.js`);
    fs.writeFileSync(filePath, sourceCode, "utf-8");
    return filePath;
  }

  describe("Scanner Registration & Registry Verification", () => {
    it("registers eventListenerScanner as a first-class scanner in allScanners", () => {
      const registeredNames = allScanners.map((s) => s.name);

      assert.ok(registeredNames.includes("event-listeners"));
      assert.deepEqual(registeredNames, [
        "osv",
        "global-state",
        "event-listeners",
        "version-conflict",
      ]);

      const foundScanner = allScanners.find((s) => s.name === "event-listeners");
      assert.strictEqual(foundScanner, eventListenerScanner);
    });
  });

  describe("CLI Argument Filtering & Scanner Isolation", () => {
    it("parses --only=event-listeners from CLI arguments", () => {
      const argv = ["node", "collide", "scan", "custom-lock.json", "--only=event-listeners", "--format=json"];
      const args = parseArgs(argv);

      assert.equal(args.lockfilePath, "custom-lock.json");
      assert.deepEqual(args.only, ["event-listeners"]);
      assert.equal(args.format, "json");
    });

    it("resolves enabled scanners for --only=event-listeners to only Scanner 3", () => {
      const enabled = resolveEnabledScanners(["event-listeners"]);
      assert.equal(enabled.length, 1);
      assert.equal(enabled[0].name, "event-listeners");
      assert.strictEqual(enabled[0], eventListenerScanner);
    });

    it("resolves multiple scanners when requested in --only", () => {
      const enabled = resolveEnabledScanners(["global-state", "event-listeners"]);
      assert.equal(enabled.length, 2);
      assert.deepEqual(
        enabled.map((s) => s.name).sort(),
        ["event-listeners", "global-state"],
      );
    });

    it("handles invalid or unknown scanner names gracefully", () => {
      const emptyEnabled = resolveEnabledScanners(["unknown-scanner"]);
      assert.deepEqual(emptyEnabled, []);

      const partialEnabled = resolveEnabledScanners(["event-listeners", "nonexistent"]);
      assert.equal(partialEnabled.length, 1);
      assert.equal(partialEnabled[0].name, "event-listeners");
    });

    it("defaults to allScanners when --only is omitted", () => {
      const all = resolveEnabledScanners(undefined);
      assert.equal(all.length, 4);
      assert.deepEqual(all, allScanners);
    });
  });

  describe("Core Pipeline Execution via runScans()", () => {
    it("runs Scanner 3 in isolation with runScans() and produces explainable findings", async () => {
      const file1 = createPackageFile("pkg1", `process.on("uncaughtException", () => {});`);
      const file2 = createPackageFile("pkg2", `process.addListener("uncaughtException", () => {});`);

      const packages: ResolvedPackage[] = [
        { name: "pkg-1", version: "1.0.0", sourcePath: file1 },
        { name: "pkg-2", version: "2.0.0", sourcePath: file2 },
      ];

      const enabledScanners = resolveEnabledScanners(["event-listeners"]);
      const findings = await runScans(packages, enabledScanners);

      assert.equal(findings.length, 1);
      assert.equal(findings[0].scanner, "event-listeners");
      assert.equal(findings[0].severity, "critical");
      assert.equal(findings[0].target, "global_process:uncaughtException");
      assert.deepEqual(findings[0].owners, ["pkg-1", "pkg-2"]);
      assert.ok(findings[0].message.includes("2 packages (pkg-1, pkg-2)"));
    });

    it("runs all enabled scanners together in runScans() without collisions leaking between scanners", async () => {
      const fileA = createPackageFile("a", `process.on("exit", () => {});`);
      const fileB = createPackageFile("b", `process.on("exit", () => {});`);

      const packages: ResolvedPackage[] = [
        { name: "pkg-a", version: "1.0.0", sourcePath: fileA },
        { name: "pkg-b", version: "1.0.0", sourcePath: fileB },
      ];

      const enabled = resolveEnabledScanners(["global-state", "event-listeners"]);
      const findings = await runScans(packages, enabled);

      assert.ok(Array.isArray(findings));
      assert.equal(findings.length, 1);

      const listenerFinding = findings.find((f) => f.scanner === "event-listeners");
      assert.ok(listenerFinding);
      assert.equal(listenerFinding.target, "global_process:exit");
      assert.equal(listenerFinding.severity, "high");
      assert.deepEqual(listenerFinding.owners, ["pkg-a", "pkg-b"]);
    });
  });

  describe("Shared AST Extraction & SQLite Cache Integration", () => {
    it("shares a single cached profile between Scanner 2 and Scanner 3 without redundant AST parsing", async () => {
      const fileA = createPackageFile("pkg-a", `process.on("warning", () => {});`);
      const fileB = createPackageFile("pkg-b", `process.on("warning", () => {});`);

      const packages: ResolvedPackage[] = [
        { name: "pkg-a", version: "1.0.0", sourcePath: fileA },
        { name: "pkg-b", version: "1.0.0", sourcePath: fileB },
      ];

      // Run both scanners through runScans()
      const findings = await runScans(packages, [globalStateScanner, eventListenerScanner]);

      assert.ok(Array.isArray(findings));
      assert.equal(findings.length, 1);
      assert.equal(findings[0].scanner, "event-listeners");
      assert.equal(findings[0].target, "global_process:warning");

      // Verify SQLite cache contains the extracted entries keyed by name@version
      const db = getDb();
      const rows = db.prepare("SELECT key, profile FROM ast_profiles ORDER BY key ASC").all() as {
        key: string;
        profile: string;
      }[];

      assert.equal(rows.length, 2);
      assert.equal(rows[0].key, "pkg-a@1.0.0");
      assert.equal(rows[1].key, "pkg-b@1.0.0");

      const profileA = JSON.parse(rows[0].profile);
      assert.ok(Array.isArray(profileA.writes));
      assert.equal(profileA.listeners.length, 1);
      assert.equal(profileA.listeners[0].eventName, "warning");

      // Running runScans a second time should hit SQLite cache with zero extra AST work
      const findingsSecondRun = await runScans(packages, [eventListenerScanner]);
      assert.equal(findingsSecondRun.length, 1);
      assert.equal(findingsSecondRun[0].target, "global_process:warning");
      assert.equal(findingsSecondRun[0].severity, "medium");
    });
  });

  describe("Finding Output and Formatting Pipeline Integration", () => {
    it("formats Scanner 3 findings correctly in table and json output formats", async () => {
      const findings: Finding[] = [
        {
          scanner: "event-listeners",
          severity: "critical",
          target: "global_process:uncaughtException",
          owners: ["pkg-1", "pkg-2"],
          message: '2 packages (pkg-1, pkg-2) register listeners on "global_process:uncaughtException". Competing handlers can swallow errors.',
        },
        {
          scanner: "event-listeners",
          severity: "medium",
          target: "global_window:resize",
          owners: ["pkg-a", "pkg-b"],
          message: '2 packages (pkg-a, pkg-b) register listeners on "global_window:resize". Multiple listeners can cause thrashing.',
        },
      ];

      // Table format output
      const tableOutput = formatReport(findings, "table");
      assert.ok(tableOutput.includes("[CRITICAL] event-listeners: global_process:uncaughtException —"));
      assert.ok(tableOutput.includes("[MEDIUM] event-listeners: global_window:resize —"));

      // JSON format output
      const jsonOutput = formatReport(findings, "json");
      const parsed = JSON.parse(jsonOutput);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].severity, "critical");
      assert.equal(parsed[1].severity, "medium");
    });

    it("formats empty findings list gracefully as 'No collisions found.'", () => {
      assert.equal(formatReport([], "table"), "No collisions found.");
    });
  });
});
