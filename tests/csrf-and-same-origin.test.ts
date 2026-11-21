import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACKS, OWN, attachCookie, fire, forgedThrough, goals, init, matrix, ownWorks, step,
  type Action, type Defences, type State,
} from "../src/playgrounds/csrf-and-same-origin/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);
const atk = (id: string) => ATTACKS.find((a) => a.id === id)!;
const d = (p: Partial<Defences>): Defences => ({ sameSite: "none", token: false, originCheck: false, acceptGet: false, freshLogin: false, ...p });

test("csrf: with SameSite=None and no checks, a hidden form moves the money", () => {
  const s = run(init(), { type: "fire", id: "form" });
  assert.equal(s.last!.transferred, true);
  assert.equal(s.balance, 1750);
  assert.equal(s.ledger[0].forged, true);
});

test("csrf: fetch() sends the POST with the cookie; CORS only hides the response (the predict answer)", () => {
  const o = fire(d({}), atk("fetch"));
  assert.equal(o.sent, true);
  assert.equal(o.cookie, true);
  assert.equal(o.transferred, true);
  const s = run(init(), { type: "fire", id: "fetch" });
  assert.equal(goals(s).corsMyth, true);
});

test("csrf: a JSON fetch needs a preflight, so it is never sent", () => {
  const o = fire(d({}), atk("fetch-json"));
  assert.equal(o.sent, false);
  assert.equal(o.transferred, false);
});

test("csrf: SameSite=Lax withholds the cookie on cross-site POSTs and images, but not on a top-level GET", () => {
  const lax = d({ sameSite: "lax", acceptGet: true });
  assert.equal(fire(lax, atk("form")).cookie, false);
  assert.equal(fire(lax, atk("fetch")).transferred, false);
  assert.equal(fire(lax, atk("img")).cookie, false);
  const link = fire(lax, atk("link"));
  assert.equal(link.cookie, true);
  assert.equal(link.transferred, true, "a state-changing GET gets through Lax");
  const s = run(init(), { type: "sameSite", value: "lax" }, { type: "toggle", key: "acceptGet" }, { type: "fire", id: "link" });
  assert.equal(goals(s).laxGet, true);
});

test("csrf: every check exempts GET, so a GET transfer gets past tokens and origin checks", () => {
  const all = d({ sameSite: "lax", token: true, originCheck: true, acceptGet: true });
  const o = fire(all, atk("link"));
  assert.equal(o.transferred, true);
  assert.deepEqual(o.checks.filter((c) => c.result === "skip").map((c) => c.id), ["origin", "token"]);
  assert.equal(fire({ ...all, acceptGet: false }, atk("link")).status, 405);
});

test("csrf: the default (no SameSite attribute) lets a top-level POST through within two minutes of login", () => {
  assert.equal(attachCookie(d({ sameSite: "default", freshLogin: true }), "attacker", "form").yes, true);
  assert.equal(attachCookie(d({ sameSite: "default", freshLogin: false }), "attacker", "form").yes, false);
  assert.equal(attachCookie(d({ sameSite: "lax", freshLogin: true }), "attacker", "form").yes, false, "explicit Lax has no allowance");
  assert.equal(attachCookie(d({ sameSite: "default", freshLogin: true }), "attacker", "fetch").yes, false, "only top-level navigations");
});

test("csrf: SameSite does nothing against a sibling subdomain; the origin check or token does", () => {
  assert.equal(fire(d({ sameSite: "strict" }), atk("sibling")).transferred, true);
  assert.equal(fire(d({ sameSite: "strict", originCheck: true }), atk("sibling")).status, 403);
  assert.equal(fire(d({ sameSite: "strict", token: true }), atk("sibling")).status, 403);
  const s = run(init(), { type: "sameSite", value: "strict" }, { type: "fire", id: "sibling" });
  assert.equal(goals(s).sibling, true);
});

test("csrf: the attacker cannot read the token: the same-origin policy hides the response", () => {
  const o = fire(d({ token: true }), atk("steal"));
  assert.equal(o.sent, true);
  assert.equal(o.readResponse, false);
});

test("csrf: tokens or the origin check alone block every forged POST and keep the user's own form working", () => {
  for (const p of [{ token: true }, { originCheck: true }]) {
    const x = d(p);
    assert.equal(forgedThrough(x), 0, JSON.stringify(p));
    assert.equal(ownWorks(x), true);
  }
  assert.equal(forgedThrough(d({})), 3, "form, fetch and sibling get through with no defences");
});

test("csrf: the user's own transfer works under every cookie setting", () => {
  for (const sameSite of ["none", "default", "lax", "strict"] as const)
    assert.equal(fire(d({ sameSite, token: true, originCheck: true }), OWN).transferred, true);
});

test("csrf: all blocked is a challenge only after firing something; reset restores the balance", () => {
  let s = run(init(), { type: "toggle", key: "originCheck" });
  assert.equal(goals(s).allBlocked, false);
  s = run(s, { type: "fire", id: "form" });
  assert.equal(goals(s).allBlocked, true);
  assert.equal(matrix(d({ originCheck: true })).every((o) => !o.transferred), true);
  s = run(s, { type: "reset" });
  assert.equal(s.balance, 2000);
});
