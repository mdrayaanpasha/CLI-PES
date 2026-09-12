import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createListenerFinding,
  formatFindingMessage,
  getCollisionRiskRationale,
  eventListenerScanner,
  groupListenerCollisions,
  ListenerCollisionGroup,
} from "./event-listeners";
import { extractPackageProfile, PackageProfile } from "./shared-ast-extractor";
import type { Finding, ResolvedPackage } from "../core/types";

describe("Stage 12: Explainable Event-Listener Finding Generation", () => {
  describe("Finding structure and schema compliance", () => {
    it("generates a Finding matching the shared project schema exactly", () => {
      const group: ListenerCollisionGroup = {
        canonicalTarget: "global_process:uncaughtException",
        owners: ["pkg-a", "pkg-b"],
        participants: [
          {
            packageName: "pkg-a",
            packageVersion: "1.0.0",
            canonicalTarget: "global_process:uncaughtException",
            listenerMethod: "on",
            eventName: "uncaughtException",
            sourceLocation: { line: 12, column: 0 },
            moduleContext: "src/index.js",
          },
          {
            packageName: "pkg-b",
            packageVersion: "2.1.0",
            canonicalTarget: "global_process:uncaughtException",
            listenerMethod: "addListener",
            eventName: "uncaughtException",
            sourceLocation: { line: 45, column: 4 },
            moduleContext: "lib/handler.js",
          },
        ],
      };

      const finding: Finding = createListenerFinding(group);

      assert.equal(finding.scanner, "event-listeners");
      assert.equal(finding.severity, "critical");
      assert.equal(finding.target, "global_process:uncaughtException");
      assert.deepEqual(finding.owners, ["pkg-a", "pkg-b"]);
      assert.ok(typeof finding.message === "string" && finding.message.length > 0);
    });
  });

  describe("Human-readable message generation and explainability", () => {
    it("includes shared target, participating packages, locations, and risk rationale", () => {
      const group: ListenerCollisionGroup = {
        canonicalTarget: "global_process:uncaughtException",
        owners: ["alpha", "beta"],
        participants: [
          {
            packageName: "alpha",
            packageVersion: "1.0.0",
            canonicalTarget: "global_process:uncaughtException",
            listenerMethod: "on",
            eventName: "uncaughtException",
            sourceLocation: { line: 10, column: 2 },
            moduleContext: "alpha.js",
          },
          {
            packageName: "beta",
            packageVersion: "2.0.0",
            canonicalTarget: "global_process:uncaughtException",
            listenerMethod: "prependListener",
            eventName: "uncaughtException",
            sourceLocation: { line: 20, column: 5 },
            moduleContext: "beta.js",
          },
        ],
      };

      const message = formatFindingMessage(group);

      // Mentions package count and names
      assert.ok(message.includes("2 packages (alpha, beta)"));
      // Mentions target
      assert.ok(message.includes('"global_process:uncaughtException"'));
      // Mentions participant registration details with method and location
      assert.ok(message.includes("alpha@1.0.0 (on at alpha.js:10:2)"));
      assert.ok(message.includes("beta@2.0.0 (prependListener at beta.js:20:5)"));
      // Mentions uncaughtException risk
      assert.ok(message.includes("uncaught exception handlers"));
      // Mentions prepend hijacking warning
      assert.ok(message.includes("Prepend registration is used"));
    });

    it("generates correct explanations across all severity tiers", () => {
      // 1. CRITICAL
      const critRationale = getCollisionRiskRationale("global_process:unhandledRejection");
      assert.ok(critRationale.includes("unhandled rejection"));

      // 2. HIGH
      const highExitRationale = getCollisionRiskRationale("global_process:exit");
      assert.ok(highExitRationale.includes("exit handlers"));

      const highSigRationale = getCollisionRiskRationale("global_process:SIGTERM");
      assert.ok(highSigRationale.includes("signal listeners"));

      const highMsgRationale = getCollisionRiskRationale("global_window:message");
      assert.ok(highMsgRationale.includes("window message"));

      // 3. MEDIUM
      const medResizeRationale = getCollisionRiskRationale("global_window:resize");
      assert.ok(medResizeRationale.includes("viewport listeners"));

      const medWarnRationale = getCollisionRiskRationale("global_process:warning");
      assert.ok(medWarnRationale.includes("warning"));

      // 4. LOW
      const lowClickRationale = getCollisionRiskRationale("global_window:click");
      assert.ok(lowClickRationale.includes("global listeners on \"click\""));
    });
  });

  describe("Multiple packages in a single collision", () => {
    it("formats 3+ packages in a collision group cleanly", () => {
      const group: ListenerCollisionGroup = {
        canonicalTarget: "global_window:resize",
        owners: ["pkg-1", "pkg-2", "pkg-3"],
        participants: [
          {
            packageName: "pkg-1",
            canonicalTarget: "global_window:resize",
            listenerMethod: "addEventListener",
            eventName: "resize",
          },
          {
            packageName: "pkg-2",
            canonicalTarget: "global_window:resize",
            listenerMethod: "addEventListener",
            eventName: "resize",
          },
          {
            packageName: "pkg-3",
            canonicalTarget: "global_window:resize",
            listenerMethod: "addEventListener",
            eventName: "resize",
          },
        ],
      };

      const finding = createListenerFinding(group);

      assert.equal(finding.severity, "medium");
      assert.deepEqual(finding.owners, ["pkg-1", "pkg-2", "pkg-3"]);
      assert.ok(finding.message.startsWith('3 packages (pkg-1, pkg-2, pkg-3) register listeners on "global_window:resize"'));
    });
  });

  describe("Handling missing optional metadata gracefully", () => {
    it("handles missing versions, locations, and contexts without errors", () => {
      const groupNoLoc: ListenerCollisionGroup = {
        canonicalTarget: "global_process:exit",
        owners: ["pkg-x", "pkg-y"],
        participants: [
          {
            packageName: "pkg-x",
            canonicalTarget: "global_process:exit",
            listenerMethod: "on",
            eventName: "exit",
          },
          {
            packageName: "pkg-y",
            canonicalTarget: "global_process:exit",
            listenerMethod: "addListener",
            eventName: "exit",
          },
        ],
      };

      const finding = createListenerFinding(groupNoLoc);

      assert.equal(finding.severity, "high");
      assert.ok(finding.message.includes("pkg-x (on)"));
      assert.ok(finding.message.includes("pkg-y (addListener)"));
    });

    it("handles empty participants list gracefully", () => {
      const groupEmpty: ListenerCollisionGroup = {
        canonicalTarget: "global_window:storage",
        owners: ["pkg-a", "pkg-b"],
        participants: [],
      };

      const finding = createListenerFinding(groupEmpty);

      assert.equal(finding.severity, "high");
      assert.ok(finding.message.startsWith('2 packages (pkg-a, pkg-b) register listeners on "global_window:storage".'));
    });
  });

  describe("Deterministic output and deduplication", () => {
    it("deduplicates identical participant registration strings from multiple calls", () => {
      const group: ListenerCollisionGroup = {
        canonicalTarget: "global_process:SIGINT",
        owners: ["pkg-a", "pkg-b"],
        participants: [
          {
            packageName: "pkg-a",
            canonicalTarget: "global_process:SIGINT",
            listenerMethod: "on",
            eventName: "SIGINT",
            moduleContext: "a.js",
            sourceLocation: { line: 10, column: 0 },
          },
          {
            packageName: "pkg-a",
            canonicalTarget: "global_process:SIGINT",
            listenerMethod: "on",
            eventName: "SIGINT",
            moduleContext: "a.js",
            sourceLocation: { line: 10, column: 0 },
          },
          {
            packageName: "pkg-b",
            canonicalTarget: "global_process:SIGINT",
            listenerMethod: "on",
            eventName: "SIGINT",
            moduleContext: "b.js",
            sourceLocation: { line: 20, column: 0 },
          },
        ],
      };

      const finding = createListenerFinding(group);

      // pkg-a should appear once in the details list
      const detailsCount = (finding.message.match(/pkg-a \(on at a\.js:10:0\)/g) || []).length;
      assert.equal(detailsCount, 1);
    });

    it("produces identical messages regardless of participant array ordering", () => {
      const p1 = {
        packageName: "pkg-1",
        canonicalTarget: "global_process:exit",
        listenerMethod: "on",
        eventName: "exit",
        moduleContext: "1.js",
        sourceLocation: { line: 5, column: 1 },
      };
      const p2 = {
        packageName: "pkg-2",
        canonicalTarget: "global_process:exit",
        listenerMethod: "addListener",
        eventName: "exit",
        moduleContext: "2.js",
        sourceLocation: { line: 8, column: 2 },
      };

      const groupA: ListenerCollisionGroup = {
        canonicalTarget: "global_process:exit",
        owners: ["pkg-1", "pkg-2"],
        participants: [p1, p2],
      };

      const groupB: ListenerCollisionGroup = {
        canonicalTarget: "global_process:exit",
        owners: ["pkg-1", "pkg-2"],
        participants: [p2, p1],
      };

      assert.equal(formatFindingMessage(groupA), formatFindingMessage(groupB));
    });
  });

  describe("End-to-end scanner execution producing complete Findings", () => {
    it("returns complete, explainable Findings from eventListenerScanner.scan", async () => {
      const code1 = `
process.on("uncaughtException", (err) => console.error(err));
window.addEventListener("resize", () => {});
`;
      const code2 = `
process.addListener("uncaughtException", (err) => report(err));
window.addEventListener("resize", () => {});
`;

      const pkgs: ResolvedPackage[] = [
        { name: "error-logger", version: "1.0.0", sourcePath: "/app/logger.js" },
        { name: "telemetry-agent", version: "2.5.0", sourcePath: "/app/telemetry.js" },
      ];

      const profiles: PackageProfile[] = [
        extractPackageProfile(code1, "error-logger", "/app/logger.js"),
        extractPackageProfile(code2, "telemetry-agent", "/app/telemetry.js"),
      ];

      const collisions = groupListenerCollisions(pkgs, profiles);
      const findings = collisions.map(createListenerFinding);

      assert.equal(findings.length, 2);

      const uncaughtFinding = findings.find((f) => f.target === "global_process:uncaughtException");
      assert.ok(uncaughtFinding);
      assert.equal(uncaughtFinding.scanner, "event-listeners");
      assert.equal(uncaughtFinding.severity, "critical");
      assert.deepEqual(uncaughtFinding.owners, ["error-logger", "telemetry-agent"]);
      assert.ok(uncaughtFinding.message.includes("error-logger@1.0.0 (on at /app/logger.js:2:0)"));
      assert.ok(uncaughtFinding.message.includes("telemetry-agent@2.5.0 (addListener at /app/telemetry.js:2:0)"));
      assert.ok(uncaughtFinding.message.includes("swallow unhandled errors"));

      const resizeFinding = findings.find((f) => f.target === "global_window:resize");
      assert.ok(resizeFinding);
      assert.equal(resizeFinding.scanner, "event-listeners");
      assert.equal(resizeFinding.severity, "medium");
      assert.deepEqual(resizeFinding.owners, ["error-logger", "telemetry-agent"]);
      assert.ok(resizeFinding.message.includes("performance degradation"));
    });
  });
});
