import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TYPES, VALUES, assignable, explain, init, members, readableKeys, resultMembers, sameAs, step, type Action, type State, type TypeId,
} from "../src/playgrounds/types-as-sets/model.ts";

const go = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("types-as-sets: never is empty, unknown is everything, and both behave as identities", () => {
  assert.equal(members("never").length, 0);
  assert.equal(members("unknown").length, VALUES.length);
  for (const t of TYPES.map((x) => x.id)) {
    assert.deepEqual(resultMembers(t, "never", "|"), members(t), `${t} | never is ${t}`);
    assert.deepEqual(resultMembers(t, "unknown", "&"), members(t), `${t} & unknown is ${t}`);
    assert.ok(assignable("never", t).ok, "never is assignable to everything");
    assert.ok(assignable(t, "unknown").ok, "everything is assignable to unknown");
  }
});

test("types-as-sets: the subset facts the lesson states hold over the sample, with a witness for each 'no'", () => {
  const yes: [TypeId, TypeId][] = [["idempotent", "method"], ["method", "string"], ["post", "method"], ["status5xx", "number"], ["retrySafe", "hasMethod"], ["postOnly", "hasMethod"]];
  for (const [a, b] of yes) assert.ok(assignable(a, b).ok, `${a} ⊆ ${b}`);
  const no: [TypeId, TypeId, string][] = [["method", "idempotent", "post"], ["string", "method", "lowerGet"], ["number", "status5xx", "s200"], ["hasUrl", "hasMethod", "health"], ["retrySafe", "hasUrl", "cfgDelete"], ["postOnly", "hasUrl", "cfgPost"]];
  for (const [a, b, w] of no) {
    const r = assignable(a, b);
    assert.equal(r.ok, false, `${a} is not ⊆ ${b}`);
    assert.equal(r.witness, w);
  }
});

test("types-as-sets: A & B asks for more properties but fits fewer values (the predicted answer)", () => {
  const and = resultMembers("hasMethod", "hasUrl", "&");
  assert.deepEqual(readableKeys("hasMethod", "hasUrl", "&"), ["method", "url"]);
  assert.deepEqual(readableKeys("hasMethod", "hasUrl", "|"), []);
  assert.ok(and.length < members("hasMethod").length && and.length < members("hasUrl").length);
  assert.ok(resultMembers("hasMethod", "hasUrl", "|").length > members("hasUrl").length);
  let s = go(init(), { type: "predict", value: "fewer" }, { type: "op", op: "&" });
  assert.ok(s.revealed);
  assert.ok(s.done.includes("shrink"));
  s = go(s, { type: "predict", value: "more" });
  assert.equal(s.predict, "fewer", "the prediction locks once revealed");
});

test("types-as-sets: conflicting literals collapse the intersection to never", () => {
  assert.equal(sameAs("idempotent", "post", "&"), "never");
  assert.equal(sameAs("retrySafe", "postOnly", "&"), "never");
  assert.equal(sameAs("string", "number", "&"), "never");
  const s = go(init(), { type: "setA", t: "retrySafe" }, { type: "setB", t: "postOnly" }, { type: "op", op: "&" });
  assert.ok(s.done.includes("never"));
  assert.match(explain(s, "reqPost").verdict, /fails A/);
});

test("types-as-sets: a subset is absorbed by | and kept by &", () => {
  assert.equal(sameAs("idempotent", "method", "|"), "b");
  assert.equal(sameAs("idempotent", "method", "&"), "a");
  const s = go(init(), { type: "setA", t: "idempotent" }, { type: "setB", t: "method" });
  assert.ok(s.done.includes("subset"));
  assert.ok(s.done.includes("absorb"));
});

test("types-as-sets: selecting toggles, reset clears", () => {
  let s = go(init(), { type: "select", v: "patch" });
  assert.equal(s.selected, "patch");
  s = go(s, { type: "select", v: "patch" });
  assert.equal(s.selected, null);
  s = go(s, { type: "swap" }, { type: "reset" });
  assert.deepEqual(s, init());
});
