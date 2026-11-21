"use client";
import { useState } from "react";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  init, isStale, overlaps, pendingHints, step,
  type Action, type Answer, type Challenge, type Rec, type Replica, type Resolve, type State,
} from "./model";

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

const CHALLENGES: { id: Challenge; title: string; note: string }[] = [
  { id: "stale", title: "Read stale data with R + W ≤ N", note: "the replicas that answered were all ones the write missed" },
  { id: "fresh", title: "Get a fresh worst-case read while a replica is stale, with R + W > N", note: "any R replicas and any W replicas share at least one" },
  { id: "sloppy", title: "Read stale data even though R + W > N", note: "a sloppy quorum wrote to spares outside the home set" },
  { id: "ghost", title: "Read a write that was reported as failed", note: "a failed quorum write is not rolled back on the replicas that took it" },
  { id: "lost", title: "Lose an acknowledged write without any error", note: "last-write-wins kept the higher timestamp and dropped the other" },
];

const recText = (x: Rec) => (x.gen === 0 ? "empty" : `v${x.gen} ${x.label}${x.client === "phone" ? " (phone)" : ""}`);

function NodeBox({ st, node, dispatch }: { st: State; node: Replica; dispatch: (a: Action) => void }) {
  const inW = st.lastWrite?.to.includes(node.id);
  const inR = st.lastRead?.ok && st.lastRead.from.includes(node.id);
  const unused = node.spare && !st.sloppy;
  const stale = node.up && isStale(st, node);
  const cls = ["qr-node", node.up ? "" : "down", node.spare ? "spare" : "", unused ? "unused" : "", stale ? "stale" : ""].join(" ");
  return (
    <button className={cls} onClick={() => dispatch({ type: "toggle", id: node.id })}
      aria-label={`${node.spare ? "Spare" : "Replica"} ${node.id}, ${node.up ? "up" : "down"}. Press to ${node.up ? "take it down" : "bring it back"}.`}>
      <span className="qr-head">
        <span>{node.spare ? `Spare ${node.id}` : `Replica ${node.id}`}</span>
        <span className="qr-state">{node.up ? "up" : "down"}</span>
      </span>
      <span className="qr-recs">
        {node.recs.length === 0 && <span className="muted">nothing</span>}
        {node.recs.map((x, i) => (
          <span key={i} className={"qr-rec" + (x.acked ? "" : " failed") + (x.hintFor ? " hint" : "")}>
            {recText(x)}{x.hintFor ? ` · hint for ${x.hintFor}` : ""}{x.acked ? "" : " · failed"}
          </span>
        ))}
      </span>
      <span className="qr-badges" aria-hidden="true">
        {inW && <span className="qr-b w">W</span>}
        {inR && <span className="qr-b r">R</span>}
        {inW && inR && <span className="qr-b both">overlap</span>}
      </span>
    </button>
  );
}

function ReadNote({ st }: { st: State }) {
  const rd = st.lastRead;
  if (!rd) return <p className="pg-empty">No read yet. Add an item, then read the cart.</p>;
  if (!rd.ok) return <div className="pg-entry fail"><p>Read failed: fewer than R = {st.r} replicas could answer. A strict quorum refuses rather than guess.</p></div>;
  const shared = (st.lastWrite?.to ?? []).filter((id) => rd.from.includes(id));
  const why = rd.ghost
    ? "This version was reported to the client as failed, but the replicas that took it kept it. Nothing rolls a failed quorum write back."
    : rd.stale && rd.overlap
      ? "R + W > N, and still stale. The last write was acknowledged by spare nodes outside the home replicas, so the overlap argument did not apply."
      : rd.stale
        ? `R + W = ${st.r + st.w} ≤ N = ${st.n}. The replicas that answered can all be ones the write missed.`
        : rd.recs.length > 1
          ? "Two concurrent versions came back. Neither replaces the other, so the application has to merge them, here by taking the union of the carts."
          : shared.length
            ? `Replica ${shared.join(", ")} took the last write and answered this read. That shared replica is the overlap.`
            : "Fresh, because every replica that answered had caught up.";
  return (
    <div className={"pg-entry" + (rd.stale || rd.ghost ? " fail" : " ok")}>
      <div className="pg-path" aria-hidden="true">{rd.from.map((id) => <span key={id}>replica {id}</span>)}<span>cart</span></div>
      <p><b>Cart: {rd.recs.map(recText).join("  |  ")}</b>{rd.stale ? " · stale" : ""}</p>
      <p>{why}</p>
    </div>
  );
}

type Guess = "fresh" | "stale" | "fail";

export default function QuorumPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [guess, setGuess] = useState<Guess | null>(null);
  const ov = overlaps(st);
  const revealed = st.done.includes("fresh") || st.done.includes("stale");
  const s = st.stats;
  const hints = pendingHints(st);
  const lw = st.lastWrite;

  return (
    <PgFrame title="One cart key on N replicas, read and written by quorum" onReset={() => { setGuess(null); dispatch({ type: "reset" }); }}>
      <PgPredict<Guess>
        question="N = 3, W = 2, R = 2. Take replica 3 down, add an item, bring replica 3 back, take replica 1 down, and read. The two replicas that answer are 2 and 3, and replica 3 missed the write. What does the read return?"
        options={[
          { value: "fresh", label: "The new item" },
          { value: "stale", label: "The old cart" },
          { value: "fail", label: "An error" },
        ]}
        value={guess} onChange={setGuess} revealed={revealed} answer="fresh"
        explain={<>Any 2 of 3 replicas share at least one replica with any other 2 of 3. Replica 2 took the write and answered the read, and the read keeps the newest version it sees. That is all R + W &gt; N promises: some replica in every read set holds the latest acknowledged write.</>}
      />

      <div className="pg-req">
        <span className="label">Quorum settings</span>
        <div className="qr-sliders">
          <div className="qr-slider">
            <span className="pg-place">N replicas</span>
            <PgChoice label="Replication factor N" value={String(st.n)} onChange={(v) => dispatch({ type: "config", n: Number(v) })}
              options={["3", "4", "5"].map((v) => ({ value: v, label: v }))} />
          </div>
          {(["w", "r"] as const).map((k) => (
            <label key={k} className="qr-slider">
              <span className="pg-place">{k === "w" ? "W write acks" : "R read replies"}</span>
              <input type="range" min={1} max={st.n} value={st[k]} onChange={(e) => dispatch(k === "w" ? { type: "config", w: Number(e.target.value) } : { type: "config", r: Number(e.target.value) })} />
              <code>{st[k]}</code>
            </label>
          ))}
        </div>
        <p className={"qr-formula" + (ov ? " ok" : " bad")} aria-live="polite">
          R + W = {st.r + st.w} {ov ? ">" : "≤"} N = {st.n}. {ov ? "Every read set shares a replica with every write set." : "A read set can miss the write set entirely."}
        </p>
        <div className="qr-modes">
          <label className="qr-check"><input type="checkbox" checked={st.sloppy} onChange={(e) => dispatch({ type: "sloppy", on: e.target.checked })} /> Sloppy quorum with hinted handoff</label>
          <div className="qr-mode"><span className="pg-place">Concurrent versions</span>
            <PgChoice<Resolve> label="Concurrent versions" value={st.resolve} onChange={(m) => dispatch({ type: "resolve", mode: m })}
              options={[{ value: "lww", label: "Last write wins" }, { value: "siblings", label: "Keep siblings" }]} /></div>
          <div className="qr-mode"><span className="pg-place">Who answers first</span>
            <PgChoice<Answer> label="Which replicas answer a read first" value={st.answer} onChange={(m) => dispatch({ type: "answer", mode: m })}
              options={[{ value: "worst", label: "Stalest (worst case)" }, { value: "rotate", label: "Rotating" }]} /></div>
        </div>
      </div>

      <div className="pg-req">
        <span className="label">Replicas · press one to take it down or bring it back</span>
        <div className={"qr-nodes" + (reduced ? "" : " anim")}>
          {st.nodes.map((node) => <NodeBox key={node.id} st={st} node={node} dispatch={dispatch} />)}
        </div>
        <div className="pg-actions">
          <PgButton primary onClick={() => dispatch({ type: "write" })}>Add item (laptop)</PgButton>
          <PgButton onClick={() => dispatch({ type: "concurrent" })} title="The laptop and the phone each add an item at the same moment">Laptop and phone add at once</PgButton>
          <PgButton primary onClick={() => dispatch({ type: "read" })}>Read cart</PgButton>
          {st.sloppy && <PgButton onClick={() => dispatch({ type: "handoff" })} disabled={!hints}>Hand off hints ({hints})</PgButton>}
        </div>
        {lw && (
          <p className={"qr-small" + (lw.ok ? "" : " qr-bad")} aria-live="polite">
            Last write {lw.label}: {lw.ok ? `acknowledged by ${n(lw.to.length, "node")} (${lw.to.join(", ")}), W = ${st.w}.` : `failed, only ${n(lw.to.length, "replica")} up for W = ${st.w}. Those ${lw.to.length ? "replicas kept it anyway." : "were none."}`}
            {lw.lost && ` Last-write-wins kept the higher timestamp. The phone's ${lw.lost} was dropped, though the phone was told it succeeded.`}
          </p>
        )}
        <ReadNote st={st} />
      </div>

      <dl className="pg-stats qr-stats">
        <div><dt>Writes ok</dt><dd>{s.writes - s.failedWrites}</dd></div>
        <div className={s.failedWrites ? "bad" : ""}><dt>Writes failed</dt><dd>{s.failedWrites}</dd></div>
        <div><dt>Reads</dt><dd>{s.reads}</dd></div>
        <div className={s.staleReads ? "bad" : ""}><dt>Stale reads</dt><dd>{s.staleReads}</dd></div>
        <div className={s.unavailableReads ? "bad" : ""}><dt>Reads refused</dt><dd>{s.unavailableReads}</dd></div>
        <div className={s.lost ? "bad" : ""}><dt>Writes lost</dt><dd>{s.lost}</dd></div>
      </dl>

      <div className="pg-req">
        <span className="label">Break it: {st.done.length} of {CHALLENGES.length}</span>
        <ul className="qr-list">
          {CHALLENGES.map((c) => {
            const got = st.done.includes(c.id);
            return <li key={c.id} className={got ? "got" : ""}><span aria-hidden="true">{got ? "■" : "□"}</span> {c.title}{got && <span className="muted"> · {c.note}.</span>}</li>;
          })}
        </ul>
      </div>

      {s.reads >= 2 && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your session showed</span>
          <p>
            You read the cart {n(s.reads, "time")}: {n(s.staleReads, "stale read")}, {s.overlapStale} of them with R + W &gt; N, {n(s.ghostReads, "read")} of a failed write, and {n(s.unavailableReads, "refused read")}. {n(s.failedWrites, "write")} failed and {n(s.lost, "acknowledged write")} vanished.
          </p>
          <p className="pg-takeaway">
            R + W &gt; N is a counting argument about one set of N replicas. It makes a read see the latest successful write, as long as that write really landed on W of those N, nothing else wrote at the same moment, and nobody counts a failed write as gone. Each of those can break in production, so quorums give fresher reads, not linearizable ones.
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "the Dynamo paper (DeCandia et al., 2007)", href: "https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf" },
        { title: "Probabilistically Bounded Staleness (Bailis et al.)", href: "https://arxiv.org/abs/1204.6082" },
        { title: "Kleppmann's DDIA on leaderless replication", href: "https://dataintensive.net/" },
      ]} />

      <style>{`
        .qr-small { font-size: .9rem; margin: 0; }
        .qr-bad { color: var(--pain); }
        .qr-sliders { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px 16px; align-items: center; }
        .qr-slider { display: grid; grid-template-columns: 8.5em minmax(0, 1fr) 2em; gap: 8px; align-items: center; }
        .qr-slider .pg-choice { grid-column: 2 / -1; justify-self: start; }
        .qr-slider input { width: 100%; accent-color: var(--accent); }
        .qr-formula { margin: 0; font-family: var(--f-code); font-size: .8rem; padding: 4px 8px; border-left: 3px solid var(--pain); background: var(--pain-bg); }
        .qr-formula.ok { border-left-color: var(--good); background: var(--good-bg); }
        .qr-modes { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
        .qr-mode { display: grid; gap: 2px; }
        .qr-check { display: flex; gap: 6px; align-items: center; font-size: .9rem; }
        .qr-nodes { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
        .qr-node { border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; display: grid; gap: 4px; text-align: left; align-content: start; min-height: 104px; color: var(--ink); }
        .qr-nodes.anim .qr-node { transition: opacity .2s var(--ease), border-color .2s var(--ease); }
        .qr-node.spare { border-style: dashed; }
        .qr-node.unused { opacity: .45; }
        .qr-node.down { background: var(--bg); opacity: .55; text-decoration: line-through; text-decoration-color: var(--ink-2); }
        .qr-node.stale { border-color: var(--pain); }
        .qr-head { display: flex; justify-content: space-between; gap: 6px; font-family: var(--f-code); font-size: .62rem; letter-spacing: .06em; text-transform: uppercase; }
        .qr-state { color: var(--ink-2); }
        .qr-recs { display: grid; gap: 2px; }
        .qr-rec { font-family: var(--f-code); font-size: .68rem; padding: 1px 4px; background: var(--good-bg); color: var(--good); }
        .qr-rec.failed { background: var(--pain-bg); color: var(--pain); }
        .qr-rec.hint { background: var(--bg); color: var(--accent); border: 1px dashed var(--accent); }
        .qr-badges { display: flex; gap: 4px; flex-wrap: wrap; min-height: 16px; }
        .qr-b { font-family: var(--f-code); font-size: .58rem; letter-spacing: .06em; text-transform: uppercase; padding: 0 5px; border: 1px solid var(--line); }
        .qr-b.w { border-color: var(--accent); color: var(--accent); }
        .qr-b.r { border-color: var(--ink); }
        .qr-b.both { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
        .qr-stats { grid-template-columns: repeat(6, minmax(0, 1fr)); }
        .qr-list { list-style: none; padding-left: 0 !important; }
        .qr-list li.got { color: var(--good); }
        @media (prefers-reduced-motion: reduce) { .qr-nodes.anim .qr-node { transition: none; } }
        @media (max-width: 520px) { .qr-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); } .qr-slider { grid-template-columns: 1fr 2em; } .qr-slider .pg-place { grid-column: 1 / -1; } .qr-slider .pg-choice { grid-column: 1 / -1; } }
      `}</style>
    </PgFrame>
  );
}
