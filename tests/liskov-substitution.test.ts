import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKENDS, CALLERS, challenges, init, matrix, run, step, tally, type Action, type State } from "../src/playgrounds/liskov-substitution/model.ts";

const go = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const status = (s: State, b: Parameters<typeof run>[1], c: Parameters<typeof run>[2]) => run(s, b, c).status;

test("lsp: S3 passes every caller; every backend type-checks, yet 5 pairs break", () => {
  const s = init();
  for (const c of CALLERS) assert.equal(status(s, "s3", c), "pass");
  const t = tally(s);
  assert.equal(t.rejected, 0, "no pair is refused by the compiler: all four implement BlobStore");
  assert.equal(t.failures, 5);
});

test("lsp: the archive breaks exactly the callers that write (the predicted answer)", () => {
  const s = init();
  assert.deepEqual(CALLERS.map((c) => status(s, "archive", c)), ["fail", "fail", "pass", "fail"]);
  assert.equal(run(s, "archive", "upload").broke, "errors");
});

test("lsp: the replica throws nothing and still breaks the thumbnailer's read-after-write", () => {
  const r = run(init(), "replica", "thumbs");
  assert.equal(r.status, "fail");
  assert.equal(r.broke, "readAfterWrite");
  assert.ok(r.steps.every((x) => !x.result.includes("Error")), "no exception anywhere in the trace");
});

test("lsp: the NFS store strengthens a precondition; short keys pass, the long thumbnail key fails", () => {
  const s = init();
  assert.equal(status(s, "nfs", "upload"), "pass");
  const r = run(s, "nfs", "thumbs");
  assert.equal(r.broke, "keys");
});

test("lsp: type checks and a weaker contract hide the crash but leave the feature broken", () => {
  for (const fix of ["typeCheck", "widen"] as const) {
    const s = go(init(), { type: "archiveFix", fix });
    const t = tally(s);
    assert.equal(t.handled, 3);
    assert.equal(t.callersEdited, 3);
  }
  assert.equal(tally(go(init(), { type: "archiveFix", fix: "typeCheck" })).namesConcrete, 3);
});

test("lsp: splitting the interface moves the archive's failures to compile time", () => {
  const s = go(init(), { type: "archiveFix", fix: "split" });
  assert.deepEqual(CALLERS.map((c) => status(s, "archive", c)), ["rejected", "rejected", "pass", "rejected"]);
  assert.equal(tally(s).callersEdited, 1);
});

test("lsp: the full challenge, every pair works or is refused, nobody names a backend", () => {
  let s = init();
  for (const b of BACKENDS) s = step(s, { type: "plug", backend: b });
  s = go(s, { type: "inspect", backend: "replica", caller: "thumbs" });
  s = go(s, { type: "archiveFix", fix: "split" }, { type: "fixReplica", on: true }, { type: "fixNfs", on: true });
  const t = tally(s);
  assert.deepEqual([t.failures, t.handled, t.namesConcrete, t.rejected], [0, 0, 0, 3]);
  assert.ok(challenges(s).every((c) => c.done));
  assert.equal(matrix(s).length, 16);
});

test("lsp: inspecting an unplugged backend plugs it; prediction locks after the archive is plugged", () => {
  let s = go(init(), { type: "predict", value: "all" }, { type: "inspect", backend: "archive", caller: "report" });
  assert.ok(s.revealed.includes("archive"));
  s = go(s, { type: "predict", value: "writers" });
  assert.equal(s.predict, "all");
});
