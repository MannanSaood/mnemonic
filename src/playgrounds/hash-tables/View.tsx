"use client";
import type { ReactNode } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHALLENGES, MAX_KEYS, TENANTS, TOMB,
  avgHit, avgMiss, hitHistogram, home, init, keysAt, load, longest, lostKeys, maxPile, step, tenantOf, theory,
  type Action, type HashKind, type MaxLoad, type Source, type State, type Strategy,
} from "./model";

const SOURCES: { value: Source; label: string; note: string }[] = [
  { value: "mixed", label: "Mixed tenants", note: "pages from six tenants" },
  { value: "big", label: "One big tenant", note: "every page belongs to acme" },
  { value: "crafted", label: "Crafted keys", note: "reorderings of the same digits: the same sum of character codes" },
];
const HASHES: { value: HashKind; label: string; note: string }[] = [
  { value: "full", label: "Whole key, seeded", note: "a seeded FNV-1a over tenant and path" },
  { value: "tenant", label: "Tenant only", note: "the bug: the path never reaches the hash" },
  { value: "sum", label: "Sum of char codes", note: "the textbook weak hash" },
];
const STRATS: { value: Strategy; label: string; note: string }[] = [
  { value: "probe", label: "Linear probing", note: "one key per slot; on a collision try the next slot" },
  { value: "chain", label: "Chaining", note: "each slot holds a list of keys" },
];
const LOADS: { value: MaxLoad; label: string }[] = [
  { value: "0.5", label: "0.5" }, { value: "0.75", label: "0.75" }, { value: "0.9", label: "0.9" }, { value: "none", label: "Never resize" },
];

const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "∞");
const tcls = (key: string) => `ht-t${Math.max(0, TENANTS.indexOf(tenantOf(key) as (typeof TENANTS)[number]))}`;
const short = (key: string) => key.slice(key.lastIndexOf("/") + 1);

function Grid({ st, dispatch, reduced }: { st: State; dispatch: (a: Action) => void; reduced: boolean }) {
  const t = st.table;
  const path = st.last?.path ?? [];
  const order = new Map(path.map((p, i) => [p, i + 1]));
  const big = t.m > 64;
  const maxChain = Math.max(1, ...t.chains.map((c) => c.length));
  return (
    <div className={"ht-grid" + (big ? " small" : "") + (reduced ? "" : " anim")} role="group" aria-label={`Bucket array with ${t.m} slots`}>
      {Array.from({ length: t.m }, (_, i) => {
        const onPath = order.has(i);
        const sel = st.selected === i;
        let body: ReactNode = null;
        let cls = "ht-cell";
        let label = `slot ${i}: empty`;
        if (t.strategy === "probe") {
          const x = t.slots[i];
          if (x === TOMB) { cls += " tomb"; label = `slot ${i}: tombstone`; body = big ? null : "†"; }
          else if (x) { cls += ` full ${tcls(x)}`; label = `slot ${i}: ${x}${home(t, x) !== i ? `, home slot ${home(t, x)}` : ""}`; body = big ? null : short(x); }
        } else {
          const c = t.chains[i];
          if (c.length) {
            cls += " chain";
            label = `slot ${i}: chain of ${c.length}`;
            body = <><i style={{ height: `${Math.min(1, c.length / maxChain) * 100}%` }} />{!big && <b>{c.length}</b>}</>;
          }
        }
        if (onPath) cls += " path";
        if (sel) cls += " sel";
        return (
          <button key={i} className={cls} aria-label={label} aria-pressed={sel}
            onClick={() => dispatch({ type: "select", slot: sel ? null : i })}>
            {body}
            {onPath && !big && <sup>{order.get(i)}</sup>}
          </button>
        );
      })}
    </div>
  );
}

function Detail({ st, dispatch }: { st: State; dispatch: (a: Action) => void }) {
  if (st.selected === null) return <p className="muted">Click a slot to see its keys, look one up, or delete it.</p>;
  const keys = keysAt(st.table, st.selected);
  const tomb = st.table.strategy === "probe" && st.table.slots[st.selected] === TOMB;
  return (
    <div className="ht-detail">
      <span className="pg-place">Slot {st.selected}{tomb ? " · tombstone: a deleted key; lookups walk past it" : keys.length ? "" : " · empty"}</span>
      <ul>
        {keys.slice(0, 12).map((k) => (
          <li key={k}>
            <code className={tcls(k)}>{k}</code>
            <span className="muted">home {home(st.table, k)}</span>
            <button className="pg-btn" onClick={() => dispatch({ type: "find", key: k })}>Find</button>
            <button className="pg-btn ht-del" onClick={() => dispatch({ type: "delete", key: k })}>Delete</button>
          </li>
        ))}
        {keys.length > 12 && <li className="muted">and {keys.length - 12} more</li>}
      </ul>
    </div>
  );
}

function lastLine(st: State): string {
  const o = st.last;
  if (!o) return "Insert some keys. Each one is hashed to a home slot.";
  const unit = st.table.strategy === "chain" ? "key comparison" : "slot read";
  const n = `${o.cost} ${unit}${o.cost === 1 ? "" : "s"}`;
  if (o.kind === "full") return `No free slot for ${o.key}: the table is full and resizing is off.`;
  if (o.kind === "delete") return `Deleted ${o.key} from slot ${o.path[o.path.length - 1]}${st.table.strategy === "probe" ? (st.tombstones ? ", leaving a tombstone so probe runs stay connected." : " by emptying the slot. Any key whose probe run crossed that slot now stops short there.") : "."}`;
  if (o.kind === "find") return o.found ? `Found ${o.key} after ${n}.` : `${o.key} was not found after ${n}. It is stored, but its probe run hits an empty slot first.`;
  const r = o.resized ? ` First the table passed its load cap, so it grew from ${o.resized.from} to ${o.resized.to} slots and rehashed all ${o.resized.moved} keys.` : "";
  return `Inserted ${o.key}: home slot ${o.path[0]}, ${n}.${r}`;
}

function Result({ st }: { st: State }) {
  const n = st.keys.length;
  const hit = avgHit(st), miss = avgMiss(st), pile = maxPile(st), lost = lostKeys(st).length;
  const strat = st.strategy === "chain" ? "chaining" : "linear probing";
  let take: string;
  if (lost) take = `${lost} stored key${lost === 1 ? " is" : "s are"} now unreachable. In open addressing, an empty slot means "stop looking", so a delete has to leave a tombstone that lookups walk past and inserts reuse.`;
  else if (pile >= 8 && st.hash !== "full") take = `${pile} keys share one home slot, so finding one reads ${f1(hit)} slots on average and grows with every key: O(n), not O(1). ${st.hash === "tenant" ? "The hash never saw the path, so a tenant's pages are one big collision." : "The keys were crafted to collide under this hash."} A seeded hash over the whole key spreads the same keys out.`;
  else if (st.strategy === "probe" && load(st) > 0.85) take = `At load ${load(st).toFixed(2)}, a miss reads ${f1(miss)} slots. Linear probing builds clusters that merge as the table fills, so cost climbs steeply near full. That is why real tables resize at 2/3 (CPython) or 7/8 (Swiss tables).`;
  else take = `With a hash that spreads the keys and a load cap, a lookup reads one or two slots whatever the size. Resizing moved ${st.moved} keys over ${st.inserts} inserts, about ${st.inserts ? (st.moved / st.inserts).toFixed(1) : "0"} per insert, but they arrive in bursts: your slowest insert did ${st.worst} units of work.`;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your table costs</span>
      <p>{n} keys in {st.table.m} slots (load {load(st).toFixed(2)}), {strat}, hash on {HASHES.find((h) => h.value === st.hash)!.label.toLowerCase()}. A hit costs {f1(hit)} on average and a miss {f1(miss)}; the longest {st.strategy === "chain" ? "chain" : "run of filled slots"} is {longest(st)}. {st.resizes} resize{st.resizes === 1 ? "" : "s"} moved {st.moved} keys.</p>
      <p className="pg-takeaway">{take}</p>
    </div>
  );
}

export default function HashTablePlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const n = st.keys.length;
  const th = theory(st.strategy, load(st));
  const hist = hitHistogram(st);
  const hmax = Math.max(1, ...hist);
  const lost = lostKeys(st).length;
  const revealed = st.hash === "tenant" && maxPile(st) >= 16;
  const unit = st.strategy === "chain" ? "compares" : "slots read";

  return (
    <PgFrame title="A render cache's key table" onReset={() => dispatch({ type: "reset" })}>
      <PgPredict
        question="Set the hash to Tenant only and the traffic to One big tenant, then insert 32 keys. The table resizes as usual, so it stays half empty. How many slots does finding one key read on average?"
        options={[{ value: "1", label: "One or two" }, { value: "4", label: "About 4" }, { value: "16", label: "About 16" }]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={revealed}
        answer="16"
        explain={<>Yours reads {f1(avgHit(st))}. Every key has the same tenant, so every key gets the same hash and the same home slot. The table size does not matter: key number n sits behind n − 1 others, and an average hit reads half of them. That is O(n) per lookup, hidden behind a map API.</>}
      />

      <div className="pg-req">
        <span className="label">Insert keys · {n} of {MAX_KEYS}</span>
        <div className="pg-actions">
          {[1, 10, 50].map((k) => <PgButton key={k} primary={k === 10} onClick={() => dispatch({ type: "insert", n: k })} disabled={n >= MAX_KEYS}>+{k}</PgButton>)}
        </div>
        <div className="ht-rows">
          <span className="pg-place">Traffic</span>
          <PgChoice<Source> label="Traffic" value={st.source} options={SOURCES} onChange={(v) => dispatch({ type: "source", value: v })} />
          <span className="pg-place">Hash</span>
          <PgChoice<HashKind> label="Hash function" value={st.hash} options={HASHES} onChange={(v) => dispatch({ type: "hash", value: v })} />
          <span className="pg-place">Collisions</span>
          <PgChoice<Strategy> label="Collision strategy" value={st.strategy} options={STRATS} onChange={(v) => dispatch({ type: "strategy", value: v })} />
          <span className="pg-place">Resize above load</span>
          <PgChoice<MaxLoad> label="Maximum load factor" value={st.maxLoad} options={LOADS} onChange={(v) => dispatch({ type: "maxLoad", value: v })} />
          {st.strategy === "probe" && <>
            <span className="pg-place">Delete</span>
            <PgChoice<string> label="How a delete clears its slot" value={st.tombstones ? "tomb" : "empty"}
              onChange={(v) => dispatch({ type: "tombstones", value: v === "tomb" })}
              options={[{ value: "tomb", label: "Leave a tombstone" }, { value: "empty", label: "Empty the slot (break it)" }]} />
          </>}
        </div>
        <p className="muted">Changing the hash, the strategy or the load cap rebuilds the table from the same keys. Colours are tenants; numbers on the path are the order the last operation read slots in.</p>
      </div>

      <div className="pg-card">
        <span className="label">Bucket array · {st.table.m} slots · home slot = hash &amp; {st.table.m - 1}</span>
        <Grid st={st} dispatch={dispatch} reduced={reduced} />
        <p className="ht-last" aria-live="polite">{lastLine(st)}</p>
        <Detail st={st} dispatch={dispatch} />
      </div>

      <div className="pg-sides">
        <div className="pg-side">
          <header><h4>Cost per lookup</h4><span className={"pg-status" + (avgHit(st) < 2 ? " done" : "")}>{unit}</span></header>
          <dl className="pg-stats ht-stats">
            <div><dt>Load</dt><dd>{load(st).toFixed(2)}</dd></div>
            <div className={avgHit(st) > 4 ? "bad" : ""}><dt>Hit · avg</dt><dd>{f1(avgHit(st))}</dd></div>
            <div className={avgMiss(st) > 6 ? "bad" : ""}><dt>Miss · avg</dt><dd>{f1(avgMiss(st))}</dd></div>
            <div><dt>Uniform theory</dt><dd>{f1(th.hit)} / {f1(th.miss)}</dd></div>
            <div className={maxPile(st) >= 8 ? "bad" : ""}><dt>Keys on one home</dt><dd>{maxPile(st)}</dd></div>
            <div><dt>{st.strategy === "chain" ? "Longest chain" : "Longest run"}</dt><dd>{longest(st)}</dd></div>
          </dl>
          <div className="ht-hist" aria-label="How many stored keys cost 1, 2, 3 and more to find">
            {hist.slice(1).map((c, i) => (
              <span key={i} title={`${c} keys cost ${i + 1}${i === 9 ? " or more" : ""}`}>
                <i style={{ height: `${(c / hmax) * 100}%` }} /><b>{i === 9 ? "10+" : i + 1}</b>
              </span>
            ))}
          </div>
          <p className="muted">How many stored keys cost 1, 2, 3 … to find.</p>
        </div>
        <div className="pg-side">
          <header><h4>Cost of growing</h4><span className="pg-status done">{st.resizes} resizes</span></header>
          <dl className="pg-stats ht-stats">
            <div><dt>Inserts</dt><dd>{st.inserts}</dd></div>
            <div><dt>Keys moved</dt><dd>{st.moved}</dd></div>
            <div><dt>Moved / insert</dt><dd>{st.inserts ? (st.moved / st.inserts).toFixed(2) : "-"}</dd></div>
            <div className={st.worst > 50 ? "bad" : ""}><dt>Slowest insert</dt><dd>{st.worst}</dd></div>
            <div><dt>Tombstones</dt><dd>{st.table.strategy === "probe" ? st.table.slots.filter((x) => x === TOMB).length : "-"}</dd></div>
            <div className={lost ? "bad" : ""}><dt>Unreachable</dt><dd>{lost}</dd></div>
          </dl>
          <p className="muted">A resize allocates twice the slots and rehashes every key. Averaged over all inserts it is a constant; on the insert that triggers it, it is all of them at once.</p>
        </div>
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {CHALLENGES.filter((c) => st.done[c.id]).length} of {CHALLENGES.length}</span>
        <ul className="ht-list">
          {CHALLENGES.map((c) => <li key={c.id} className={st.done[c.id] ? "got" : ""}><span aria-hidden="true">{st.done[c.id] ? "■" : "□"}</span> {c.text}</li>)}
        </ul>
      </div>

      {n >= 8 && <Result st={st} />}

      <PgSources links={[
        { title: "VisuAlgo's hash table visualisation", href: "https://visualgo.net/en/hashtable" },
        { title: "David Galles' closed hashing visualisation (USF)", href: "https://www.cs.usfca.edu/~galles/visualization/ClosedHash.html" },
        { title: "the Go blog on Swiss tables", href: "https://go.dev/blog/swisstable" },
      ]} />

      <style>{CSS}</style>
    </PgFrame>
  );
}

const CSS = `
.ht-rows { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; align-items: center; }
.ht-grid { display: grid; grid-template-columns: repeat(16, minmax(0, 1fr)); gap: 2px; padding: 6px; border: 1px solid var(--line); background: var(--surface); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; }
.ht-grid.small { grid-template-columns: repeat(32, minmax(0, 1fr)); gap: 1px; }
.ht-cell { position: relative; min-width: 0; height: 30px; padding: 0; border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-family: var(--f-code); font-size: .56rem; overflow: hidden; cursor: pointer; display: grid; place-items: center; }
.ht-grid.small .ht-cell { height: 12px; }
.ht-cell.full { background: color-mix(in srgb, var(--c) 30%, var(--surface)); border-color: var(--c); }
.ht-cell.tomb { background: repeating-linear-gradient(45deg, var(--surface-2) 0 3px, var(--surface) 3px 6px); color: var(--ink-2); }
.ht-cell.chain i { position: absolute; left: 0; right: 0; bottom: 0; background: var(--accent); opacity: .35; }
.ht-cell.chain b { position: relative; font-weight: 700; }
.ht-cell.path { outline: 2px solid var(--pain); outline-offset: -1px; z-index: 1; }
.ht-cell.sel { box-shadow: inset 0 0 0 2px var(--ink); }
.ht-cell sup { position: absolute; top: 0; right: 1px; font-size: .5rem; color: var(--pain); font-weight: 700; }
.ht-grid.anim .ht-cell { transition: background-color .25s var(--ease), outline-color .25s var(--ease); }
.ht-t0 { --c: var(--accent); } .ht-t1 { --c: var(--pain); } .ht-t2 { --c: var(--good); } .ht-t3 { --c: var(--shiki-token-constant); }
.ht-t4 { --c: var(--ink-2); } .ht-t5 { --c: color-mix(in srgb, var(--pain) 50%, var(--shiki-token-constant)); }
code.ht-t0, code.ht-t1, code.ht-t2, code.ht-t3, code.ht-t4, code.ht-t5 { border-left: 3px solid var(--c); padding-left: 4px; }
.ht-last { margin: 0; font-size: .92rem; }
.ht-detail ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 4px; }
.ht-detail li { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: .85rem; }
.ht-del { color: var(--pain); }
.ht-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ht-hist { display: grid; grid-template-columns: repeat(10, minmax(0, 1fr)); gap: 3px; height: 70px; align-items: end; }
.ht-hist span { position: relative; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; }
.ht-hist i { display: block; background: var(--accent); min-height: 1px; transition: height .3s var(--ease); }
.ht-hist span:nth-child(n+4) i { background: var(--pain); }
.ht-hist b { font-family: var(--f-code); font-size: .55rem; text-align: center; color: var(--ink-2); font-weight: 400; }
.ht-list { list-style: none; padding-left: 0 !important; }
.ht-list li.got { color: var(--good); }
@media (max-width: 520px) { .ht-rows { grid-template-columns: 1fr; } .ht-grid { grid-template-columns: repeat(8, minmax(0, 1fr)); } .ht-grid.small { grid-template-columns: repeat(16, minmax(0, 1fr)); } }
@media (prefers-reduced-motion: reduce) { .ht-grid.anim .ht-cell, .ht-hist i { transition: none; } }
`;
