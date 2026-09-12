import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCanonicalListenerKey } from "./event-listeners";
import { extractPackageProfile } from "./shared-ast-extractor";

describe("Stage 8: Listener Target Canonicalization", () => {
  it("normalizes all process listener registration methods to the exact same canonical target", () => {
    const methods = [
      'process.on("uncaughtException", fn);',
      'process.addListener("uncaughtException", fn);',
      'process.once("uncaughtException", fn);',
      'process.prependListener("uncaughtException", fn);',
      'process.prependOnceListener("uncaughtException", fn);',
    ];

    for (const code of methods) {
      const profile = extractPackageProfile(code);
      assert.equal(profile.listeners.length, 1);
      const canonicalKey = getCanonicalListenerKey(profile.listeners[0]);
      assert.equal(canonicalKey, "global_process:uncaughtException");
    }
  });

  it("normalizes equivalent string literal quotes and static templates to the same canonical key", () => {
    const variations = [
      'process.on("uncaughtException", fn);',
      "process.on('uncaughtException', fn);",
      "process.on(`uncaughtException`, fn);",
      'process.on("uncaught" + "Exception", fn);',
    ];

    for (const code of variations) {
      const profile = extractPackageProfile(code);
      assert.equal(profile.listeners.length, 1);
      const canonicalKey = getCanonicalListenerKey(profile.listeners[0]);
      assert.equal(canonicalKey, "global_process:uncaughtException");
    }
  });

  it("differentiates distinct event names on global process", () => {
    const code = `
process.on("exit", fn);
process.on("beforeExit", fn);
process.on("unhandledRejection", fn);
process.on("SIGINT", fn);
`;
    const profile = extractPackageProfile(code);
    assert.equal(profile.listeners.length, 4);

    const keys = profile.listeners.map(getCanonicalListenerKey);
    assert.deepEqual(keys, [
      "global_process:exit",
      "global_process:beforeExit",
      "global_process:unhandledRejection",
      "global_process:SIGINT",
    ]);
  });

  it("canonicalizes browser globals explicitly and deterministically", () => {
    const code = `
window.addEventListener("resize", fn);
globalThis.window.addEventListener('resize', fn);
document.addEventListener("DOMContentLoaded", fn);
window.document.addEventListener('DOMContentLoaded', fn);
`;
    const profile = extractPackageProfile(code);
    assert.equal(profile.listeners.length, 4);

    assert.equal(getCanonicalListenerKey(profile.listeners[0]), "global_window:resize");
    assert.equal(getCanonicalListenerKey(profile.listeners[1]), "global_window:resize");
    assert.equal(getCanonicalListenerKey(profile.listeners[2]), "global_document:DOMContentLoaded");
    assert.equal(getCanonicalListenerKey(profile.listeners[3]), "global_document:DOMContentLoaded");
  });

  it("does NOT incorrectly merge unrelated or local emitters with global_process", () => {
    const code = `
const process = customEmitter;
process.on("uncaughtException", fn);

const myServer = new EventEmitter();
myServer.on("uncaughtException", fn);

const p = someOtherEmitter;
p.on("uncaughtException", fn);
`;
    const profile = extractPackageProfile(code);
    assert.equal(profile.listeners.length, 3);

    const keys = profile.listeners.map(getCanonicalListenerKey);

    // None of these should match global_process:uncaughtException
    for (const key of keys) {
      assert.notEqual(key, "global_process:uncaughtException");
    }

    assert.deepEqual(keys, [
      "module_emitter:process:uncaughtException",
      "module_emitter:myServer:uncaughtException",
      "module_emitter:p:uncaughtException",
    ]);
  });

  it("handles DOM element canonical targets distinct from global window/document", () => {
    const code = `
const btn = document.getElementById("btn");
btn.addEventListener("click", fn);
document.body.addEventListener("click", fn);
`;
    const profile = extractPackageProfile(code);
    assert.equal(profile.listeners.length, 2);

    assert.equal(getCanonicalListenerKey(profile.listeners[0]), "dom_element:btn:click");
    assert.equal(getCanonicalListenerKey(profile.listeners[1]), "dom_element:document.body:click");
  });
});
