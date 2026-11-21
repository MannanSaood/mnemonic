import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROBES, build, counterfactual, execute, goals, init, parse, seedDb, send, step, tokenize, totals,
  type Action, type State,
} from "../src/playgrounds/injection-and-parameterised-queries/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const last = (s: State) => s.runs[s.runs.length - 1];
const go: Action = { type: "send" };
const q = (text: string): Action => ({ type: "q", q: text });
const probe = (label: string): Action => ({ type: "probe", index: PROBES.findIndex((p) => p.label.startsWith(label)) });

test("injection: the tiny SQL engine runs the honest query, scoped to one tenant and sorted", () => {
  const ex = execute(seedDb(), parse("SELECT id, name FROM customers WHERE tenant_id = 42 AND name ILIKE '%a%' ORDER BY name DESC"), []);
  assert.deepEqual(ex.columns, ["id", "name"]);
  assert.ok(ex.rows.length >= 3);
  assert.ok(ex.rows.every((r) => [1, 2, 3, 4, 5].includes(r.id as number)));
  assert.equal(ex.rows[0].name, "Siobhan O'Brien");
});

test("injection: a normal search works the same in all three builds", () => {
  for (const b of ["concat", "escape", "param"] as const) {
    const r = last(run(init(), { type: "build", build: b }, q("grace"), go));
    assert.equal(r.status, 200);
    assert.deepEqual(r.rows.map((x) => x.name), ["Grace Hopper"]);
    assert.equal(r.codeChars, 0);
  }
});

test("injection: an apostrophe breaks the concatenating build with a syntax error; the others find the customer", () => {
  const s = run(init(), probe("O'Brien"), go);
  assert.equal(last(s).status, 500);
  assert.match(last(s).error!, /unterminated quoted string/);
  for (const b of ["escape", "param"] as const) {
    const r = last(run(init(), { type: "build", build: b }, probe("O'Brien"), go));
    assert.deepEqual(r.rows.map((x) => x.name), ["Siobhan O'Brien"]);
  }
});

test("injection: ' OR 1=1 -- returns every tenant's customers (the predict answer)", () => {
  const s = run(init(), probe("' OR 1=1"), go);
  const r = last(s);
  assert.equal(r.status, 200);
  assert.equal(r.rows.length, 8);
  assert.equal(r.otherTenantRows, 3);
  assert.ok(r.codeChars > 0);
  assert.ok(r.pieces.some((p) => p.from === "template" && p.disabled), "the comment switched off the rest of the template");
  assert.equal(goals(s.runs).otherTenant, true);
});

test("injection: UNION reads the users table through the search box", () => {
  const s = run(init(), probe("' UNION"), go);
  assert.equal(last(s).secretsRead, 3);
  assert.equal(goals(s.runs).secrets, true);
});

test("injection: a stacked DELETE wipes the table, and the next search finds nothing", () => {
  let s = run(init(), probe("'; DELETE"), go);
  assert.equal(last(s).effects.statements, 2);
  assert.equal(last(s).effects.deleted, 8);
  s = run(s, q("ada"), go);
  assert.equal(last(s).rows.length, 0);
  s = run(s, { type: "restore" }, go);
  assert.equal(last(s).rows.length, 1);
});

test("injection: parameters keep every probe as data", () => {
  for (const p of PROBES.filter((x) => x.q)) {
    const { run: r, db } = send(seedDb(), "param", { q: p.q!, sort: "name" });
    assert.equal(r.status, 200, p.label);
    assert.equal(r.codeChars, 0);
    assert.equal(r.otherTenantRows + r.secretsRead + r.effects.deleted, 0);
    assert.equal(db.customers.rows.length, 8);
    assert.deepEqual(r.params, [42, p.q]);
    assert.ok(!r.sql.includes(p.q!), "the input never enters the SQL text");
  }
});

test("injection: escaping quotes stops the string probes but not the sort column", () => {
  const strOk = send(seedDb(), "escape", { q: "' OR 1=1 --", sort: "name" }).run;
  assert.equal(strOk.otherTenantRows, 0);
  assert.equal(strOk.codeChars, 0);
  const s = run(init(), { type: "build", build: "escape" }, probe("sort="), go);
  assert.deepEqual(last(s).effects.dropped, ["customers"]);
  assert.equal(goals(s.runs).escapeBroken, true);
  const after = run(s, q("ada"), go);
  assert.match(last(after).error!, /relation "customers" does not exist/);
});

test("injection: the allow-list rejects an unknown sort with a 400 before any SQL is built", () => {
  const r = last(run(init(), { type: "build", build: "param" }, probe("sort="), go));
  assert.equal(r.status, 400);
  assert.equal(r.sql, "");
  const ok = build("param", { q: "", sort: "created" });
  assert.match(ok.sql, /ORDER BY created_at$/);
  assert.equal(build("param", { q: "", sort: "constructor" }).rejected !== null, true);
});

test("injection: counterfactual runs leave the database alone; totals add up", () => {
  const s = run(init(), probe("'; DELETE"));
  const cf = counterfactual(s);
  assert.equal(cf.find((r) => r.build === "concat")!.effects.deleted, 8);
  assert.equal(s.db.customers.rows.length, 8);
  const s2 = run(s, go);
  assert.equal(totals(s2.runs, "concat").extraStatements, 1);
  assert.equal(totals(s2.runs, "param").deleted, 0);
});

test("injection: tokenizer keeps doubled quotes inside one string literal", () => {
  const t = tokenize("'O''Brien'").filter((x) => x.kind !== "ws");
  assert.equal(t.length, 1);
  assert.equal(t[0].value, "O'Brien");
});
