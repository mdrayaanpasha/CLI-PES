import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPackageProfile } from "./shared-ast-extractor";

describe("Stage 4: Global Process Receiver Detection and Alias Resolution", () => {
  it("detects direct global process calls across all listener methods", () => {
    const code = `
process.on("exit", onExit);
process.once("beforeExit", onBeforeExit);
process.addListener("uncaughtException", onUncaught);
process.prependListener("unhandledRejection", onUnhandled);
process.prependOnceListener("SIGTERM", onSigterm);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 5);

    const methods = ["on", "once", "addListener", "prependListener", "prependOnceListener"];
    const events = ["exit", "beforeExit", "uncaughtException", "unhandledRejection", "SIGTERM"];

    for (let i = 0; i < 5; i++) {
      assert.deepEqual(profile.listeners[i], {
        targetIdentity: { type: "emitter", name: "process" },
        receiverScope: "global",
        listenerMethod: methods[i],
        eventName: events[i],
        sourceLocation: { line: i + 2, column: 0 },
      });
    }
  });

  it("detects globalThis.process and global.process calls", () => {
    const code = `
globalThis.process.on("exit", onExit);
global.process.once("beforeExit", onBeforeExit);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "exit",
      sourceLocation: { line: 2, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "once",
      eventName: "beforeExit",
      sourceLocation: { line: 3, column: 0 },
    });
  });

  it("resolves require('process') and require('node:process') aliases", () => {
    const code = `
const p1 = require("process");
p1.on("exit", onExit);

const p2 = require("node:process");
p2.once("beforeExit", onBeforeExit);

require("process").addListener("SIGINT", onSigint);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "exit",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "once",
      eventName: "beforeExit",
      sourceLocation: { line: 6, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "addListener",
      eventName: "SIGINT",
      sourceLocation: { line: 8, column: 0 },
    });
  });

  it("resolves ESM imports of process module", () => {
    const code = `
import proc from "process";
proc.on("exit", onExit);

import * as nodeProc from "node:process";
nodeProc.once("beforeExit", onBeforeExit);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "exit",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "once",
      eventName: "beforeExit",
      sourceLocation: { line: 6, column: 0 },
    });
  });

  it("resolves direct and transitive variable aliases", () => {
    const code = `
const p = process;
p.on("exit", onExit);

const a = process;
const b = a;
const c = b;
c.once("beforeExit", onBeforeExit);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "exit",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "once",
      eventName: "beforeExit",
      sourceLocation: { line: 8, column: 0 },
    });
  });

  it("correctly distinguishes local emitters and avoids false process matches", () => {
    const code = `
const process = someEmitter;
process.on("custom", handler);

const p = new EventEmitter();
p.on("data", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    // Locally initialized process variable is NOT global process (scope is module)
    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "custom",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "emitter", name: "p" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "data",
      sourceLocation: { line: 6, column: 0 },
    });
  });

  it("handles lexical shadowing across functions, blocks, and parameters", () => {
    const code = `
function handlerWithParam(process) {
  process.on("data", () => {});
}

const arrowHandler = (process) => {
  process.on("data", () => {});
};

function localBlockScope() {
  {
    const process = createLocalEmitter();
    process.on("localEvent", () => {});
  }
}

try {
  run();
} catch (process) {
  process.on("error", () => {});
}
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 4);

    for (let i = 0; i < 4; i++) {
      // None of the shadowed variables should be marked with receiverScope: "global"
      assert.equal(profile.listeners[i].receiverScope, "module");
      assert.equal(profile.listeners[i].targetIdentity.name, "process");
    }
  });

  it("rejects unrelated requires and local module imports", () => {
    const code = `
const p1 = require("events");
p1.on("data", handler);

const p2 = require("./process");
p2.on("data", handler);

import customProcess from "./process";
customProcess.on("data", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "p1" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "data",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "emitter", name: "p2" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "data",
      sourceLocation: { line: 6, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "emitter", name: "customProcess" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "data",
      sourceLocation: { line: 9, column: 0 },
    });
  });

  it("safely ignores destructuring or unsupported alias patterns", () => {
    const code = `
const { p } = { p: process };
p.on("data", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 1);
    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "p" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "data",
      sourceLocation: { line: 3, column: 0 },
    });
  });
});
