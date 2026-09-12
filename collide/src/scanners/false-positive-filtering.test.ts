import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEligibleCollisionListener,
  isBenignLifecycleTarget,
  groupListenerCollisions,
  eventListenerScanner,
} from "./event-listeners";
import { extractPackageProfile, PackageProfile, ListenerRegistration } from "./shared-ast-extractor";
import type { ResolvedPackage } from "../core/types";

describe("Stage 10: False-Positive Filtering and Deduplication", () => {
  describe("isBenignLifecycleTarget and isEligibleCollisionListener filters", () => {
    it("identifies benign lifecycle targets accurately", () => {
      assert.ok(isBenignLifecycleTarget("global_document:DOMContentLoaded"));
      assert.ok(isBenignLifecycleTarget("global_window:load"));
      assert.ok(isBenignLifecycleTarget("global_document:readystatechange"));
      assert.ok(!isBenignLifecycleTarget("global_process:uncaughtException"));
      assert.ok(!isBenignLifecycleTarget("global_process:exit"));
      assert.ok(!isBenignLifecycleTarget("global_window:resize"));
      assert.ok(!isBenignLifecycleTarget("global_window:message"));
    });

    it("filters out local/non-global scopes from collision eligibility", () => {
      const localEmitter: ListenerRegistration = {
        targetIdentity: { type: "emitter", name: "server" },
        receiverScope: "module",
        listenerMethod: "on",
        eventName: "request",
        sourceLocation: { line: 1, column: 0 },
      };
      assert.equal(isEligibleCollisionListener(localEmitter), false);

      const domElement: ListenerRegistration = {
        targetIdentity: { type: "element", name: "myButton" },
        receiverScope: "dom",
        listenerMethod: "addEventListener",
        eventName: "click",
        sourceLocation: { line: 1, column: 0 },
      };
      assert.equal(isEligibleCollisionListener(domElement), false);
    });

    it("filters out dynamic or unknown event names", () => {
      const unknownEvent: ListenerRegistration = {
        targetIdentity: { type: "emitter", name: "process" },
        receiverScope: "global",
        listenerMethod: "on",
        eventName: "<unknown>",
        sourceLocation: { line: 1, column: 0 },
      };
      assert.equal(isEligibleCollisionListener(unknownEvent), false);

      const emptyEvent: ListenerRegistration = {
        targetIdentity: { type: "emitter", name: "process" },
        receiverScope: "global",
        listenerMethod: "on",
        eventName: "",
        sourceLocation: { line: 1, column: 0 },
      };
      assert.equal(isEligibleCollisionListener(emptyEvent), false);
    });

    it("accepts valid global process and window listeners", () => {
      const globalProcess: ListenerRegistration = {
        targetIdentity: { type: "emitter", name: "process" },
        receiverScope: "global",
        listenerMethod: "on",
        eventName: "uncaughtException",
        sourceLocation: { line: 1, column: 0 },
      };
      assert.ok(isEligibleCollisionListener(globalProcess));

      const globalWindow: ListenerRegistration = {
        targetIdentity: { type: "window" },
        receiverScope: "global",
        listenerMethod: "addEventListener",
        eventName: "resize",
        sourceLocation: { line: 1, column: 0 },
      };
      assert.ok(isEligibleCollisionListener(globalWindow));
    });
  });

  describe("End-to-end filtering and deduplication", () => {
    it("filters benign DOMContentLoaded and load listeners across packages", () => {
      const code1 = `document.addEventListener("DOMContentLoaded", () => {});`;
      const code2 = `globalThis.document.addEventListener("DOMContentLoaded", () => {});`;
      const code3 = `window.addEventListener("load", () => {});`;

      const pkgs: ResolvedPackage[] = [
        { name: "pkg-1", version: "1.0.0" },
        { name: "pkg-2", version: "1.0.0" },
        { name: "pkg-3", version: "1.0.0" },
      ];

      const profiles: PackageProfile[] = [
        extractPackageProfile(code1, "pkg-1", "1.js"),
        extractPackageProfile(code2, "pkg-2", "2.js"),
        extractPackageProfile(code3, "pkg-3", "3.js"),
      ];

      const collisions = groupListenerCollisions(pkgs, profiles);
      assert.equal(collisions.length, 0);
    });

    it("filters local emitters and DOM buttons across packages", () => {
      const code1 = `
const server = require("http").createServer();
server.on("request", () => {});
btn.addEventListener("click", () => {});
`;
      const code2 = `
const server = require("http").createServer();
server.on("request", () => {});
btn.addEventListener("click", () => {});
`;

      const pkgs: ResolvedPackage[] = [
        { name: "mod-a", version: "1.0.0" },
        { name: "mod-b", version: "1.0.0" },
      ];

      const profiles: PackageProfile[] = [
        extractPackageProfile(code1, "mod-a", "a.js"),
        extractPackageProfile(code2, "mod-b", "b.js"),
      ];

      const collisions = groupListenerCollisions(pkgs, profiles);
      assert.equal(collisions.length, 0);
    });

    it("filters dynamic/unknown events across packages", () => {
      const code1 = `process.on(getDynamicEvent(), () => {});`;
      const code2 = `process.on(EVENT_VAR, () => {});`;

      const pkgs: ResolvedPackage[] = [
        { name: "dyn-a", version: "1.0.0" },
        { name: "dyn-b", version: "1.0.0" },
      ];

      const profiles: PackageProfile[] = [
        extractPackageProfile(code1, "dyn-a", "a.js"),
        extractPackageProfile(code2, "dyn-b", "b.js"),
      ];

      const collisions = groupListenerCollisions(pkgs, profiles);
      assert.equal(collisions.length, 0);
    });

    it("deduplicates multiple registrations from the same package", () => {
      const codeSolo = `
process.on("SIGINT", () => {});
process.addListener("SIGINT", () => {});
process.once("SIGINT", () => {});
process.prependListener("SIGINT", () => {});
`;
      const pkgs: ResolvedPackage[] = [{ name: "solo-pkg", version: "1.0.0" }];
      const profiles: PackageProfile[] = [extractPackageProfile(codeSolo, "solo-pkg", "solo.js")];

      const collisions = groupListenerCollisions(pkgs, profiles);
      assert.equal(collisions.length, 0);
    });

    it("reports legitimate cross-package collisions with deterministic deduplication", () => {
      const codeA = `
process.on("uncaughtException", fnA1);
process.prependListener("uncaughtException", fnA2);
window.addEventListener("resize", fnA3);
`;
      const codeB = `
process.addListener("uncaughtException", fnB1);
window.addEventListener("resize", fnB2);
`;

      const pkgs: ResolvedPackage[] = [
        { name: "pkg-alpha", version: "1.0.0" },
        { name: "pkg-beta", version: "2.0.0" },
      ];

      const profiles: PackageProfile[] = [
        extractPackageProfile(codeA, "pkg-alpha", "a.js"),
        extractPackageProfile(codeB, "pkg-beta", "b.js"),
      ];

      const collisions = groupListenerCollisions(pkgs, profiles);

      assert.equal(collisions.length, 2);

      // Exactly 1 finding per unique canonical target
      assert.equal(collisions[0].canonicalTarget, "global_process:uncaughtException");
      assert.deepEqual(collisions[0].owners, ["pkg-alpha", "pkg-beta"]);
      assert.equal(collisions[0].participants.length, 3); // fnA1, fnA2, fnB1

      assert.equal(collisions[1].canonicalTarget, "global_window:resize");
      assert.deepEqual(collisions[1].owners, ["pkg-alpha", "pkg-beta"]);
      assert.equal(collisions[1].participants.length, 2); // fnA3, fnB2
    });
  });
});
