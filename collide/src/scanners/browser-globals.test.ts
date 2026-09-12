import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPackageProfile } from "./shared-ast-extractor";

describe("Stage 5: Global Browser Receiver Detection", () => {
  it("detects direct global window, document, and globalThis receivers", () => {
    const code = `
window.addEventListener("resize", onResize);
document.addEventListener("DOMContentLoaded", onLoad);
globalThis.addEventListener("error", onError);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

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

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "error",
      sourceLocation: { line: 4, column: 0 },
    });
  });

  it("normalizes globalThis.window, globalThis.document, and window.document", () => {
    const code = `
globalThis.window.addEventListener("scroll", onScroll);
globalThis.document.addEventListener("click", onClick);
window.document.addEventListener("keydown", onKeydown);
global.window.addEventListener("load", onLoad);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 4);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "scroll",
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
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "keydown",
      sourceLocation: { line: 4, column: 0 },
    });

    assert.deepEqual(profile.listeners[3], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "load",
      sourceLocation: { line: 5, column: 0 },
    });
  });

  it("resolves static variable aliases for window and document", () => {
    const code = `
const win = window;
win.addEventListener("resize", onResize);

const doc = document;
doc.addEventListener("visibilitychange", onVis);

const w1 = globalThis.window;
const w2 = w1;
w2.addEventListener("blur", onBlur);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "resize",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "visibilitychange",
      sourceLocation: { line: 6, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "blur",
      sourceLocation: { line: 10, column: 0 },
    });
  });

  it("handles other supported listener methods on browser globals", () => {
    const code = `
window.on("custom", handleCustom);
document.once("ready", handleReady);
globalThis.on("event", handleEvent);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "custom",
      sourceLocation: { line: 2, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "once",
      eventName: "ready",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "emitter", name: "globalThis" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "event",
      sourceLocation: { line: 4, column: 0 },
    });
  });

  it("correctly rejects shadowed window and document variables", () => {
    const code = `
function withParam(window) {
  window.addEventListener("click", () => {});
}

function withDocParam(document) {
  document.addEventListener("click", () => {});
}

{
  const window = new CustomEventEmitter();
  window.addEventListener("custom", () => {});
}

const document = getCustomDOM();
document.addEventListener("click", () => {});
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 4);

    // None of the shadowed variables should be marked as global window/document
    for (const listener of profile.listeners) {
      assert.equal(listener.receiverScope, "dom");
      assert.equal(listener.targetIdentity.type, "element");
    }
  });

  it("rejects arbitrary objects with property names matching window or document", () => {
    const code = `
const obj = { window: customTarget, document: customDoc };
obj.window.addEventListener("click", handler);
this.document.addEventListener("scroll", handler);
app.state.window.addEventListener("resize", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 3);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "element", name: "obj.window" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "click",
      sourceLocation: { line: 3, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "element", name: "this.document" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "scroll",
      sourceLocation: { line: 4, column: 0 },
    });

    assert.deepEqual(profile.listeners[2], {
      targetIdentity: { type: "element", name: "app.state.window" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "resize",
      sourceLocation: { line: 5, column: 0 },
    });
  });

  it("handles dynamic and unsupported receiver expressions safely", () => {
    const code = `
(getWindow()).addEventListener("click", handler);
(getDoc())["addEventListener"]("load", handler);
`;
    const profile = extractPackageProfile(code);

    assert.equal(profile.listeners.length, 2);

    assert.deepEqual(profile.listeners[0], {
      targetIdentity: { type: "element", name: "getWindow()" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "click",
      sourceLocation: { line: 2, column: 0 },
    });

    assert.deepEqual(profile.listeners[1], {
      targetIdentity: { type: "element", name: "getDoc()" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "load",
      sourceLocation: { line: 3, column: 0 },
    });
  });
});
