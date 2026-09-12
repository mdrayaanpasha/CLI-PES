import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getListenerId } from "./event-listeners";
import { ListenerRegistration } from "./shared-ast-extractor";

describe("eventListenerScanner normalization", () => {
  it("normalizes window event listener", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "window" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "resize",
      sourceLocation: { line: 10, column: 5 },
    };
    assert.equal(getListenerId(listener), "window:resize");
  });

  it("normalizes document event listener", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "document" },
      receiverScope: "global",
      listenerMethod: "addEventListener",
      eventName: "DOMContentLoaded",
      sourceLocation: { line: 12, column: 0 },
    };
    assert.equal(getListenerId(listener), "document:DOMContentLoaded");
  });

  it("normalizes named element event listener", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "element", name: "myButton" },
      receiverScope: "dom",
      listenerMethod: "addEventListener",
      eventName: "click",
      sourceLocation: { line: 1, column: 1 },
    };
    assert.equal(getListenerId(listener), "element:myButton:click");
  });

  it("normalizes EventEmitter listener", () => {
    const listener: ListenerRegistration = {
      targetIdentity: { type: "emitter", name: "server" },
      receiverScope: "module",
      listenerMethod: "on",
      eventName: "request",
      sourceLocation: { line: 5, column: 0 },
    };
    assert.equal(getListenerId(listener), "emitter:server:request");
  });
});
