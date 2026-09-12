import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPackageProfile } from "./shared-ast-extractor";

describe("shared-ast-extractor Event-Listener Call Detection", () => {
  it("detects standard window and document addEventListener calls", () => {
    const code = `
window.addEventListener("resize", onResize);
document.addEventListener("DOMContentLoaded", onLoad);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "resize",
      sourceLocation: { line: 2, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "DOMContentLoaded",
      sourceLocation: { line: 3, column: 0 },
    });
  });

  it("detects DOM element addEventListener calls with correct target name", () => {
    const code = `
const btn = document.getElementById("submit");
btn.addEventListener("click", handleClick);
document.body.addEventListener("mousemove", handleMove);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "element", name: "btn" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "click",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "element", name: "document.body" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "mousemove",
      sourceLocation: { line: 4, column: 0 },
    });
  });

  it("detects all supported EventEmitter methods", () => {
    const code = `
emitter.on("data", onData);
emitter.once("ready", onReady);
emitter.addListener("status", onStatus);
emitter.prependListener("first", onFirst);
emitter.prependOnceListener("init", onInit);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 5);

    const methods = ["on", "once", "addListener", "prependListener", "prependOnceListener"];
    const events = ["data", "ready", "status", "first", "init"];

    for (let i = 0; i < 5; i++) {
      assert.deepEqual(profile.listeners[i], {
        targetIdentity: { type: "emitter", name: "emitter" },
        receiverScope: "module",
        listenerMethod: methods[i],
        eventName: events[i],
        sourceLocation: { line: i + 2, column: 0 },
      });
    }
  });

  it("handles computed member expressions and bracket notation", () => {
    const code = `
emitter["on"]("data", onData);
window['addEventListener']("scroll", onScroll);
obj[\`once\`]("custom", onCustom);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "emitter", name: "emitter" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "data",
      sourceLocation: { line: 2, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "scroll",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "emitter", name: "obj" },
      receiverScope: "module",
      listenerMethod: "once",
      eventName: "custom",
      sourceLocation: { line: 4, column: 0 },
    });
  });

  it("handles globalThis, global, and prefixed global targets", () => {
    const code = `
globalThis.window.addEventListener("load", onLoad);
window.document.addEventListener("click", onClick);
globalThis.addEventListener("error", onError);
global.on("uncaughtException", onEx);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 4);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "load",
      sourceLocation: { line: 2, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "click",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "error",
      sourceLocation: { line: 4, column: 0 },
    });

    assert.deepEqual(profile.listeners[3], {
      targetIdentity: { type: "emitter", name: "global" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "uncaughtException",
      sourceLocation: { line: 5, column: 0 },
    });
  });

  it("handles dynamic event names and complex/nested receiver expressions", () => {
    const code = `
emitter.on(getEventName(), handler);
emitter.on(EVENT_CONST, handler);
(getEmitter()).on("message", handler);
this.server.on("connect", handler);
emitter.on();
emitter.on(123, handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 6);

    assert.equal(profile.listeners[0].eventName, "<unknown>");
    assert.equal(profile.listeners[1].eventName, "<unknown>");
    assert.deepEqual(profile.listeners[2].targetIdentity, {
      type: "emitter",
      name: "getEmitter()",
    });
    assert.deepEqual(profile.listeners[3].targetIdentity, {
      type: "emitter",
      name: "this.server",
    });
    assert.equal(profile.listeners[4].eventName, "<unknown>");
    assert.equal(profile.listeners[5].eventName, "123");
  });

  it("handles optional chaining and parenthesized expressions", () => {
    const code = `
emitter?.on?.("data", handler);
(window).addEventListener("blur", handler);
((bus))["addListener"]("ping", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);
    assert.equal(profile.listeners[0].eventName, "data");
    assert.deepEqual(profile.listeners[0].targetIdentity, { type: "emitter", name: "emitter" });
    assert.equal(profile.listeners[1].eventName, "blur");
    assert.deepEqual(profile.listeners[1].targetIdentity, { type: "window" });
    assert.equal(profile.listeners[2].eventName, "ping");
    assert.deepEqual(profile.listeners[2].targetIdentity, { type: "emitter", name: "bus" });
  });

  it("propagates packageContext and moduleContext", () => {
    const code = `window.addEventListener("resize", handler);`;
    const profile = extractPackageProfile(code, "my-package", "src/index.ts");

    assert.equal(profile.listeners.length, 1);
    assert.equal(profile.listeners[0].packageContext, "my-package");
    assert.equal(profile.listeners[0].moduleContext, "src/index.ts");
  });

  it("avoids false positives from unrelated methods and non-call references", () => {
    const code = `
emitter.emit("data");
emitter.removeListener("data", handler);
obj.foo("bar");
obj.filter((x) => x.on);
const handler = emitter.on;
obj[dynamicMethod]("event", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 0);
  });

  it("detects nested listeners inside functions and callbacks", () => {
    const code = `
function setup() {
  window.addEventListener("load", () => {
    const el = document.getElementById("app");
    el.addEventListener("click", () => {
      emitter.on("finish", () => {});
    });
  });
}
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);
    assert.equal(profile.listeners[0].listenerMethod, "addEventListener");
    assert.equal(profile.listeners[0].eventName, "load");
    assert.equal(profile.listeners[1].listenerMethod, "addEventListener");
    assert.equal(profile.listeners[1].eventName, "click");
    assert.equal(profile.listeners[2].listenerMethod, "on");
    assert.equal(profile.listeners[2].eventName, "finish");
  });
});
