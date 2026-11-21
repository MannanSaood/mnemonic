import { test } from "node:test";
import assert from "node:assert/strict";
import { init, step, typedReady, type Action, type State } from "../src/playgrounds/interfaces-and-polymorphism/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("interfaces: plugging WhatsApp changes 0 lines of notify() in the interface design", () => {
  const s = run(init(), { type: "plug", id: "whatsapp" });
  assert.equal(s.iface.total.notifyLines, 0);
  assert.equal(s.iface.total.failures, 0);
  assert.ok(s.iface.log.some((x) => x.kind === "queued"), "the 03:12 message waits for morning");
  assert.ok(s.iface.log.some((x) => x.kind === "sent"));
});

test("interfaces: the type-check design fails until it learns the name, and needs 3 lines", () => {
  let s = run(init(), { type: "plug", id: "whatsapp" });
  assert.ok(s.typed.total.failures > 0, "unknown channel before the case exists");
  s = run(s, { type: "addCase", id: "whatsapp" }, { type: "addQuiet", id: "whatsapp" });
  assert.equal(s.typed.total.notifyLines, 3);
  assert.ok(typedReady(s.typed, "whatsapp"));
});

test("interfaces: forgetting the quiet list wakes a customer with no error", () => {
  const s = run(init(), { type: "plug", id: "whatsapp" }, { type: "addCase", id: "whatsapp" });
  assert.equal(s.typed.total.wokeUp, 1);
  assert.ok(s.typed.log.every((x) => x.kind !== "error"));
});

test("interfaces: static typing rejects Slack before it ships; the fix is in Slack's own file", () => {
  let s = run(init("static"), { type: "plug", id: "slack" });
  assert.deepEqual(s.iface.rejected, ["slack"]);
  assert.equal(s.iface.total.failures, 0);
  s = run(s, { type: "fixSlack" });
  assert.ok(s.iface.channels.includes("slack"));
  assert.equal(s.iface.total.notifyLines, 0);
  assert.equal(s.iface.total.failures, 0);
});

test("interfaces: duck typing ships Slack and fails at runtime on the missing method", () => {
  const s = run(init("duck"), { type: "plug", id: "slack" });
  assert.equal(s.iface.rejected.length, 0);
  assert.equal(s.iface.total.failures, 3);
});

test("interfaces: a fake plugs into the interface design with no production edits and no real sends", () => {
  let s = run(init(), { type: "plug", id: "fake" });
  assert.equal(s.iface.total.realSends, 0);
  assert.ok(s.iface.log.every((x) => x.kind === "recorded"));
  s = run(s, { type: "addCase", id: "fake" });
  assert.equal(s.typed.total.testLinesInProd, 2, "the type-check design needs test code in production");
});

test("interfaces: reset keeps the typing mode", () => {
  const s = run(init("duck"), { type: "plug", id: "fake" }, { type: "reset" });
  assert.equal(s.typing, "duck");
  assert.equal(s.plugged.length, 0);
});
