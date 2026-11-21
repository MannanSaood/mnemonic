import { test } from "node:test";
import assert from "node:assert/strict";
import { CHECKS, PAYLOADS, analyse, compileErrors, init, run, step, tally, type Action, type CheckId, type State } from "../src/playgrounds/narrowing/model.ts";

const go = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const add = (...cs: CheckId[]): Action[] => cs.map((check) => ({ type: "toggle", check }));
const needed: CheckId[] = ["instanceof", "guard", "equality", "null"];

test("narrowing: with no checks, body is unknown and the use does not compile", () => {
  const rows = analyse(init());
  assert.equal(rows[rows.length - 1].type, "unknown");
  assert.ok(compileErrors(init()) >= 2);
});

test("narrowing: typeof then in moves unknown to object to object with a string type", () => {
  const s = go(init(), ...add("typeof", "in"));
  const rows = analyse(s);
  assert.equal(rows.find((r) => r.point === "typeof")!.type, "object");
  assert.match(rows.find((r) => r.point === "in")!.type, /Record<"type", unknown>; body.type: string/);
  assert.match(rows.find((r) => r.point === "use")!.error!, /Property 'data' does not exist/);
});

test("narrowing: in on unknown is a compile error, and at runtime it throws on a string payload", () => {
  const s = go(init(), ...add("in"));
  assert.ok(analyse(s).find((r) => r.point === "in")!.error);
  assert.equal(run(s, "ping").outcome.kind, "crash");
});

test("narrowing: guard + equality + null + instanceof reach zero errors and seven correct outcomes", () => {
  const s = go(init(), ...add(...needed));
  assert.equal(compileErrors(s), 0);
  const t = tally(s);
  assert.equal(t.crashes, 0);
  assert.equal(t.correct, PAYLOADS.length);
  assert.ok(s.done.includes("compile") && s.done.includes("allCorrect"));
});

test("narrowing: each needed check is load-bearing for the compiler", () => {
  for (const c of needed) {
    const s = go(init(), ...add(...needed.filter((x) => x !== c)));
    assert.ok(compileErrors(s) > 0, `without ${c} the handler does not compile`);
  }
  const noEq = go(init(), ...add("instanceof", "guard", "null"));
  assert.match(analyse(noEq).find((r) => r.point === "use")!.error!, /failureCode/);
  assert.equal(run(noEq, "succeeded").outcome.kind, "wrongEmail", "erased types: run anyway and the paid customer gets a failure email");
});

test("narrowing: a mutation in a plugin callback is invisible to the compiler and crashes at runtime", () => {
  let s = go(init(), ...add(...needed), { type: "predict", value: "silent" }, { type: "hook", on: true });
  assert.equal(compileErrors(s), 0, "the compiler still believes customer is a Customer");
  assert.match(analyse(s).find((r) => r.point === "hook")!.type, /customer: Customer/);
  const r = run(s, "erased");
  assert.equal(r.outcome.kind, "crash");
  assert.match(r.outcome.text, /reading 'email'/);
  s = go(s, { type: "payload", id: "erased" });
  assert.ok(s.done.includes("callback"));
  s = go(s, { type: "predict", value: "flags" });
  assert.equal(s.predict, "silent", "prediction locks once the hook is installed");
  s = go(s, { type: "recheck", on: true });
  assert.equal(tally(s).correct, PAYLOADS.length);
  assert.ok(s.done.includes("fixed"));
});

test("narrowing: a lying guard is trusted, so a truncated event gets past it and crashes", () => {
  const honest = go(init(), ...add(...needed));
  assert.equal(run(honest, "partial").outcome.kind, "rejected");
  const s = go(honest, { type: "guardLies", on: true }, { type: "payload", id: "partial" });
  assert.equal(compileErrors(s), 0);
  assert.equal(run(s, "partial").outcome.kind, "crash");
  assert.ok(s.done.includes("liar"));
});

test("narrowing: checks keep code order; toggling twice removes; recheck needs the hook; reset", () => {
  let s = go(init(), ...add("null", "typeof", "guard"));
  assert.deepEqual(s.checks, CHECKS.filter((c) => ["typeof", "guard", "null"].includes(c)));
  s = go(s, ...add("typeof"));
  assert.ok(!s.checks.includes("typeof"));
  s = go(s, { type: "recheck", on: true });
  assert.equal(s.recheck, false);
  assert.deepEqual(go(s, { type: "reset" }), init());
});
