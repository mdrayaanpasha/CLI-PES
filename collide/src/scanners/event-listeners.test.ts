import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getListenerId } from "./event-listeners";
import { ListenerRegistration } from "./shared-ast-extractor";

describe("eventListenerScanner canonical collision keys", () => {
  it("normalizes window event listener to global_window target", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "resize",
      sourceLocation: { line: 10, column: 5 },
    };
    assert.equal(getListenerId(listener), "global_window:resize");
  });

  it("normalizes document event listener to global_document target", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "DOMContentLoaded",
      sourceLocation: { line: 12, column: 0 },
    };
    assert.equal(getListenerId(listener), "global_document:DOMContentLoaded");
  });

  it("normalizes named element event listener to dom_element target", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "element", name: "myButton" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "click",
      sourceLocation: { line: 1, column: 1 },
    };
    assert.equal(getListenerId(listener), "dom_element:myButton:click");
  });

  it("normalizes EventEmitter listener to module_emitter target", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "emitter", name: "server" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "request",
      sourceLocation: { line: 5, column: 0 },
    };
    assert.equal(getListenerId(listener), "module_emitter:server:request");
  });

  it("normalizes global Node.js process listener to global_process target", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "emitter", name: "process" },
      receiverScope: "global",
      listenerMethod: "on",
      eventName: "uncaughtException",
      sourceLocation: { line: 1, column: 0 },
    };
    assert.equal(getListenerId(listener), "global_process:uncaughtException");
  });
});
