import { test } from "node:test";
import assert from "node:assert/strict";
import { allWirings, init, isFamily, space, step, trace, type Action, type State } from "../src/playgrounds/abstract-factory/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("abstract-factory: the half-migrated staging config fails silently", () => {
  const s = run(init(), { type: "send" });
  assert.equal(s.last!.outcome, "silent");
  assert.ok(s.last!.hops[0].ok, "the upload itself succeeds");
});

test("abstract-factory: storage from the wrong cloud fails loudly, wrong secrets crash-loop the worker", () => {
  assert.equal(trace({ storage: "aws", queue: "aws", secrets: "aws" }, "gcp").outcome, "upload-error");
  assert.equal(trace({ storage: "gcp", queue: "gcp", secrets: "aws" }, "gcp").outcome, "crashloop");
  assert.equal(trace({ storage: "gcp", queue: "gcp", secrets: "gcp" }, "gcp").outcome, "processed");
});

test("abstract-factory: with three settings exactly 1 of 8 wirings works", () => {
  const s = init();
  const all = allWirings(s);
  assert.equal(all.length, 8);
  assert.equal(all.filter((w) => trace(w, "gcp").outcome === "processed").length, 1);
  assert.ok(all.some((w) => trace(w, "gcp").outcome === "silent"));
});

test("abstract-factory: the factory design can only express whole families", () => {
  let s = run(init(), { type: "design", design: "factory" });
  assert.ok(isFamily(s.wiring));
  s = run(s, { type: "set", slot: "queue", cloud: "aws" });
  assert.deepEqual(s.wiring, { storage: "aws", queue: "aws", secrets: "aws" });
  assert.equal(space(s).possible, 2);
  assert.ok(allWirings(s).every((w) => trace(w, "gcp").outcome !== "silent"), "no family fails silently");
});

test("abstract-factory: Azure is cheap for the factory, a cache is not", () => {
  const s = run(init(), { type: "addAzure" }, { type: "addCache" });
  assert.equal(space(s).possible, 27);
  assert.equal(s.azureCost!.factory.places, 0);
  assert.equal(s.azureCost!.settings.places, 3);
  assert.equal(s.cacheCost!.factory.places, 4, "interface + 3 factories");
  assert.equal(s.cacheCost!.settings.places, 1);
});
