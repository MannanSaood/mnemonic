"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  avgFill, init, LEAF_CAP, leafCount, levels, MAX_KEYS, pageCount, pagesRead, RANGE, realHeight, showKey, spread, step, WINDOW,
  type Action, type Challenge, type KeyKind, type Lookup, type SplitRule, type State, type Tree,
} from "./model";

const KINDS: { value: KeyKind; label: string; note: string }[] = [
  { value: "serial", label: "bigint identity", note: "1, 2, 3, ... from a sequence" },
  { value: "v7", label: "UUIDv7", note: "time-ordered UUIDs from three app servers" },
  { value: "v4", label: "UUIDv4", note: "random UUIDs" },
];
const kindName = (k: KeyKind) => KINDS.find((x) => x.value === k)!.label;

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "grow", title: "Make a tree grow to three levels", note: "only a root split adds a level, so every leaf stays at the same depth" },
  { id: "scatter", title: `Make ${WINDOW} random-key inserts write to 40 or more leaf pages`, note: "each random key lands wherever its value sorts, so the writes spread over the whole index" },
  { id: "halfEmpty", title: "Leave time-ordered leaves about half empty (200+ keys)", note: "a textbook half split leaves every left page at 50% and ascending keys never come back to fill it" },
  { id: "shallow", title: "Find one key among 1,000+ in five page reads or fewer", note: "a lookup reads one page per level, whatever the row count" },
];

const ROWS = [
  { value: "1e6", label: "1 million" },
  { value: "1e8", label: "100 million" },
  { value: "1e10", label: "10 billion" },
];

const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (k: number, one: string, many = one + "s") => `${k.toLocaleString("en")} ${k === 1 ? one : many}`;

function rangeLeaves(t: Tree, l: Lookup): Set<number> {
  const out = new Set<number>();
  let id: number | null = l.path[l.path.length - 1];
  for (let i = 0; i <= l.leavesWalked && id !== null; i++) { out.add(id); id = t.nodes[id].next; }
  return out;
}

function PageMap({ t, lookup, reduced }: { t: Tree; lookup: Lookup | null; reduced: boolean }) {
  const lv = levels(t);
  const written = new Set(t.batchWritten), created = new Set(t.batchCreated);
  const onPath = new Set(lookup?.path ?? []);
  const walked = lookup?.range ? rangeLeaves(t, lookup) : new Set<number>();
  return (
    <div className={"bt-map" + (reduced ? "" : " anim")} aria-hidden="true">
      {lv.map((ids, depth) => {
        const leaf = depth === lv.length - 1;
        const wide = ids.length <= 10;
        return (
          <div key={depth} className="bt-level">
            <span className="bt-lname">{depth === 0 ? "root" : leaf ? "leaves" : `level ${depth}`}</span>
            <div className={"bt-row" + (wide ? " wide" : "")}>
              {ids.map((id) => {
                const n = t.nodes[id];
                const fill = leaf ? n.keys.length / LEAF_CAP : n.kids.length / 8;
                const cls = ["bt-page", created.has(id) ? "new" : written.has(id) ? "hot" : "", onPath.has(id) || walked.has(id) ? "path" : ""].join(" ");
                return (
                  <span key={id} className={cls} title={`page ${id}: ${leaf ? `${n.keys.length} of ${LEAF_CAP} keys` : `${n.kids.length} children`}`}>
                    <i style={{ height: pct(fill) }} />
                    {wide && <b>{leaf ? `${n.keys.length}/${LEAF_CAP}` : n.kids.length}</b>}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Lane({ st, lane, dispatch, lastN, reduced }: { st: State; lane: 0 | 1; dispatch: (a: Action) => void; lastN: number; reduced: boolean }) {
  const t = st.trees[lane];
  const l = st.lookups[lane];
  const leaves = leafCount(t);
  let insertNote = "Empty index. Insert some rows.";
  if (t.count && lastN === 1 && t.lastKey !== null) {
    const leaf = t.nodes[t.path[t.path.length - 1]];
    insertNote = `Key ${showKey(t.kind, t.lastKey)} went ${t.path.length > 1 ? `through ${plural(t.path.length - 1, "internal page")} to` : "straight to"} leaf ${leaf.id}${t.batchSplits ? `, which overflowed and split (${plural(t.batchSplits, "split")}). The new page's first key was copied up as a separator.` : ` (${leaf.keys.length} of ${LEAF_CAP} keys).`}`;
  } else if (t.count) {
    insertNote = `Last ${plural(lastN, "insert")}: ${plural(t.batchSplits, "page split")}, ${plural(t.batchWritten.length, "different leaf page")} written.`;
  }
  return (
    <div className="pg-side">
      <header><h4>Index {lane === 0 ? "A" : "B"}</h4><span className="pg-place">{kindName(t.kind)}</span></header>
      <PgChoice<KeyKind> label={`Primary key type for index ${lane === 0 ? "A" : "B"}`} value={t.kind} options={KINDS}
        onChange={(kind) => dispatch({ type: "kind", lane, kind })} />
      <PageMap t={t} lookup={l} reduced={reduced} />
      <p className="bt-sr">{`Index ${lane === 0 ? "A" : "B"}: ${t.height} levels, ${leaves} leaf pages, ${pct(avgFill(t))} full.`}</p>
      <p className="bt-note" aria-live="polite">{insertNote}</p>
      {l && (
        <p className="bt-note bt-look" aria-live="polite">
          {l.range ? `Range scan from ${showKey(t.kind, l.key)} for ${RANGE} keys` : `Lookup of ${showKey(t.kind, l.key)}`}: {plural(pagesRead(l), "page")} read
          {l.range ? ` (${l.path.length} down the tree, then ${l.leavesWalked} along the leaf chain).` : `, one per level.`}
        </p>
      )}
      <dl className="pg-stats bt-stats">
        <div><dt>Rows</dt><dd>{t.count.toLocaleString("en")}</dd></div>
        <div><dt>Height</dt><dd>{t.height}</dd></div>
        <div><dt>Pages</dt><dd>{pageCount(t)}</dd></div>
        <div className={t.count >= 50 && avgFill(t) < 0.6 ? "bad" : ""}><dt>Leaf fill</dt><dd>{t.count ? pct(avgFill(t)) : "-"}</dd></div>
        <div><dt>Splits</dt><dd>{t.splits}</dd></div>
        <div className={spread(t) >= 40 ? "bad" : ""}><dt>Leaves / last {WINDOW}</dt><dd>{t.window.length ? spread(t) : "-"}</dd></div>
      </dl>
    </div>
  );
}

type Guess = "same" | "v4" | "v7";

export default function BTreePlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const [lastN, setLastN] = useState(0);
  const [rows, setRows] = useState("1e8");
  const ins = (n: number) => { setLastN(n); dispatch({ type: "insert", n }); };
  const full = st.trees.every((t) => t.count >= MAX_KEYS);
  const [a, b] = st.trees;
  const revealed = st.trees.every((t) => t.window.length >= WINDOW) && st.inserted >= 300;
  const r = Number(rows);

  return (
    <PgFrame title="Two primary-key indexes, the same inserts" onReset={() => { setGuess(null); setLastN(0); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="Index A gets UUIDv7 keys, index B gets UUIDv4 keys. Press +100 three times. Over the last 100 inserts, which index wrote to more different leaf pages?"
        options={[
          { value: "same", label: "About the same" },
          { value: "v4", label: "UUIDv4, several times more" },
          { value: "v7", label: "UUIDv7, it splits more" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="v4"
        explain={<>A time-ordered key is always the largest so far, so every insert goes to the rightmost leaf, and 100 inserts touch only the dozen or so pages at the right edge. A random key lands wherever its value sorts, so 100 inserts touch about 100 different leaves. In a real table those leaves are mostly not in memory: each insert reads a page from disk and dirties it.</>}
      />

      <div className="pg-req">
        <span className="label">Insert rows into both indexes</span>
        <div className="pg-actions">
          {[1, 10, 100, 1000].map((n) => (
            <PgButton key={n} primary={n === 100} onClick={() => ins(n)} disabled={full}>+{n.toLocaleString("en")}</PgButton>
          ))}
          <PgButton onClick={() => dispatch({ type: "lookup" })} disabled={!a.count}>Look up a key</PgButton>
          <PgButton onClick={() => dispatch({ type: "lookup", range: true })} disabled={!a.count}>Range scan {RANGE} keys</PgButton>
        </div>
        <div className="bt-rule">
          <span className="pg-place">Split rule (rebuilds both)</span>
          <PgChoice<SplitRule> label="Split rule" value={st.rule} onChange={(rule) => dispatch({ type: "rule", rule })}
            options={[
              { value: "rightEdge", label: "Right edge stays full", note: "PostgreSQL and InnoDB: the rightmost page keeps about 90% when it splits" },
              { value: "half", label: "Always split in half", note: "the textbook rule" },
            ]} />
        </div>
        <p className="muted">Each square is one page; its shading is how full it is. Teal: written by the last insert. Green: created by a split. Outlined: read by the last lookup. A leaf holds {LEAF_CAP} keys here; a real 8 KB page holds a few hundred.</p>
      </div>

      <div className="pg-sides">
        <Lane st={st} lane={0} dispatch={dispatch} lastN={lastN} reduced={reduced} />
        <Lane st={st} lane={1} dispatch={dispatch} lastN={lastN} reduced={reduced} />
      </div>

      <div className="pg-req">
        <span className="label">The same tree at real page size</span>
        <PgChoice label="Rows in the table" value={rows} onChange={setRows} options={ROWS} />
        <p>
          A {ROWS.find((x) => x.value === rows)!.label}-row table: a bigint primary key index is {realHeight(r, 366)} levels deep (about 366 entries per page at 90% fill),
          a uuid one is {realHeight(r, 262)} levels (about 262). A lookup reads that many pages, and the top levels are almost always cached.
        </p>
      </div>

      <div className="pg-req">
        <span className="label">Challenges: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="bt-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {st.inserted >= 300 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your inserts showed</span>
          <p>
            You inserted {plural(a.count, "row")} into each index. {kindName(a.kind)} (A): {a.height} levels, {plural(leafCount(a), "leaf page")} at {pct(avgFill(a))} full, {plural(a.splits, "split")}, and its last {WINDOW} inserts wrote {plural(spread(a), "leaf page")}.
            {" "}{kindName(b.kind)} (B): {b.height} levels, {plural(leafCount(b), "leaf page")} at {pct(avgFill(b))} full, {plural(b.splits, "split")}, and {plural(spread(b), "leaf page")} for its last {WINDOW} inserts.
          </p>
          <p className="pg-takeaway">
            Lookups cost one page per level in both trees, and the height barely moves as rows grow. What the key decides is where inserts land: ordered keys append at the right edge and keep pages full, random keys split pages all over the index and keep the whole index as the working set.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "David Galles' B+ tree visualisation (USF)", href: "https://www.cs.usfca.edu/~galles/visualization/BPlusTree.html" },
        { title: "Use The Index, Luke: anatomy of an index", href: "https://use-the-index-luke.com/sql/anatomy" },
        { title: "the PostgreSQL B-tree documentation", href: "https://www.postgresql.org/docs/current/btree.html" },
      ]} />

      <style>{`
        .bt-rule { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
        .bt-map { display: grid; gap: 4px; padding: 6px; border: 1px solid var(--line); background: var(--surface); background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px); background-size: 12px 12px; min-height: 64px; }
        .bt-level { display: grid; grid-template-columns: 4.2em minmax(0, 1fr); gap: 6px; align-items: start; }
        .bt-lname { font-family: var(--f-code); font-size: .56rem; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); padding-top: 2px; }
        .bt-row { display: flex; flex-wrap: wrap; gap: 2px; }
        .bt-page { position: relative; width: 8px; height: 10px; border: 1px solid var(--line); background: var(--surface); overflow: hidden; }
        .bt-page i { position: absolute; left: 0; right: 0; bottom: 0; background: var(--ink-2); opacity: .45; }
        .bt-row.wide .bt-page { width: 34px; height: 22px; }
        .bt-page b { position: relative; display: block; text-align: center; font-family: var(--f-code); font-size: .58rem; line-height: 20px; font-weight: 600; color: var(--ink); }
        .bt-page.hot { border-color: var(--accent); }
        .bt-page.hot i { background: var(--accent); opacity: .8; }
        .bt-page.new { border-color: var(--good); }
        .bt-page.new i { background: var(--good); opacity: .8; }
        .bt-page.path { outline: 2px solid var(--ink); outline-offset: 0; z-index: 1; }
        .bt-map.anim .bt-page i { transition: height .2s var(--ease), background-color .2s var(--ease); }
        .bt-note { margin: 0; font-size: .9rem; }
        .bt-look { color: var(--ink-2); }
        .bt-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .bt-list { list-style: none; padding-left: 0 !important; }
        .bt-list li.got { color: var(--good); }
        .bt-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        @media (prefers-reduced-motion: reduce) { .bt-map.anim .bt-page i { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
