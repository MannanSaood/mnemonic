import { test } from "node:test";
import assert from "node:assert/strict";
import { BIG_AT, LIMIT_MB, amount, challengeDone, init, step, type Action, type State } from "../src/playgrounds/iterator/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("iterator: exactly one invoice is over $5,000, on page 3", () => {
  for (let i = 0; i < 2000; i++) assert.equal(amount(i) > 5000, i === BIG_AT);
  assert.equal(Math.floor(BIG_AT / 100) + 1, 3);
});

test("iterator: finding the first big invoice fetches 200 pages eagerly and 3 lazily", () => {
  const s = run(init(), { type: "run" });
  assert.equal(s.runs!.eager.calls, 200);
  assert.equal(s.runs!.lazy.calls, 3);
  assert.ok(s.runs!.lazy.peakMb < s.runs!.eager.peakMb);
  assert.ok(s.runs!.lazy.firstMs! < s.runs!.eager.firstMs!);
  assert.ok(challengeDone(s, "firstBig20k"));
});

test("iterator: exporting 200,000 invoices runs the eager design out of memory, not the iterator", () => {
  const s = run(init(), { type: "setJob", job: "export" }, { type: "setTotal", total: 200_000 }, { type: "run" });
  assert.equal(s.runs!.eager.outcome, "oom");
  assert.equal(s.runs!.eager.processed, 0);
  assert.equal(s.runs!.lazy.outcome, "done");
  assert.ok(s.runs!.lazy.peakMb < LIMIT_MB);
  assert.ok(challengeDone(s, "oom"));
});

test("iterator: a failing page loses everything eagerly, only the page in flight lazily", () => {
  const s = run(init(), { type: "setJob", job: "export" }, { type: "setFailing", on: true }, { type: "run" });
  assert.equal(s.runs!.eager.processed, 0);
  assert.equal(s.runs!.lazy.processed, 400);
  assert.equal(s.runs!.lazy.resumeAt, 5);
  assert.ok(challengeDone(s, "failSaved"));
});

test("iterator: a job that stops before the failing page never sees the failure lazily", () => {
  const s = run(init(), { type: "setFailing", on: true }, { type: "run" });
  assert.equal(s.runs!.lazy.outcome, "done");
  assert.equal(s.runs!.eager.outcome, "failed");
});

test("iterator: offset paging with inserts shows duplicates; cursor paging does not", () => {
  let s = run(init(), { type: "setJob", job: "export" }, { type: "setInserts", on: true }, { type: "run" });
  assert.ok(s.runs!.lazy.duplicates > 0);
  assert.ok(challengeDone(s, "dupes"));
  s = run(s, { type: "setPaging", paging: "cursor" }, { type: "run" });
  assert.equal(s.runs!.lazy.duplicates, 0);
  assert.ok(challengeDone(s, "cursorClean"));
});

test("iterator: pulling one at a time fetches a page only when crossing into it, and stops when the job is done", () => {
  let s = run(init(), { type: "setPageSize", size: 25 });
  s = run(s, { type: "pull" });
  assert.equal(s.pull.pagesFetched, 1);
  for (let i = 0; i < 25; i++) s = step(s, { type: "pull" });
  assert.equal(s.pull.pagesFetched, 2);
  for (let i = 0; i < 400; i++) s = step(s, { type: "pull" });
  assert.ok(s.pull.done);
  assert.equal(s.pull.pagesFetched, Math.ceil((BIG_AT + 1) / 25));
});
