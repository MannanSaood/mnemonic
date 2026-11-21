import { test } from "node:test";
import assert from "node:assert/strict";
import { GOD_OBJECT_RULES, init, mediatorLinks, redundant, step, wiredLinks, type Action, type State } from "../src/playgrounds/mediator/model.ts";

const run = (s: State, ...actions: Action[]) => actions.reduce(step, s);

test("mediator: changing the country cascades in the wired page and re-renders Place order three times", () => {
  const s = run(init(), { type: "change", comp: "country" });
  const w = s.last!.wired, m = s.last!.mediator;
  assert.equal(w.updates.placeOrder, 3);
  assert.ok(redundant(w) > 0);
  assert.equal(redundant(m), 0, "the mediator updates each component once");
  assert.equal(m.hops[0].to, "mediator");
});

test("mediator: the gift card edits four existing components when wired, one file with a mediator", () => {
  const s = run(init(), { type: "add", addon: "giftCard" });
  const c = s.costs[0];
  assert.equal(c.wiredFiles.length, 4);
  assert.deepEqual(c.mediatorFiles, ["mediator"]);
  assert.equal(wiredLinks(s.calls), 13);
  assert.equal(mediatorLinks(s.comps), 7);
});

test("mediator: loyalty points and promo codes clearing each other loop when wired", () => {
  const s = run(init(), { type: "add", addon: "loyalty" }, { type: "change", comp: "promo" });
  assert.equal(s.last!.wired.loop, true);
  assert.equal(s.last!.mediator.loop, false);
  assert.equal(s.last!.mediator.updates.loyalty, 1);
  assert.equal(s.loopsSeen, 1);
});

test("mediator: after all three requests the mediator itself becomes the biggest piece", () => {
  const s = run(init(), { type: "add", addon: "giftCard" }, { type: "add", addon: "loyalty" }, { type: "add", addon: "deliverySlot" });
  assert.ok(s.rules > GOD_OBJECT_RULES);
  assert.equal(s.costs.reduce((k, c) => k + c.wiredFiles.length, 0), 9);
  assert.equal(run(s, { type: "add", addon: "loyalty" }), s, "adding twice does nothing");
});
