"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  BIG_AT, CHALLENGES, FAIL_PAGE, JOBS, LIMIT_MB, PAGE_SIZES, TOTALS, amount, challengeDone, init, needed, pages, step,
  type Design, type Job, type Paging, type Run, type State,
} from "./model";

const CODE: Record<Lang, Record<Design, string>> = {
  go: {
    eager: "invoices, err := client.ListAll(ctx) // every page, then\nfor _, inv := range invoices { … }",
    lazy: "for inv, err := range client.Invoices(ctx) { … } // iter.Seq2",
  },
  python: {
    eager: "invoices = list(client.list_all())  # every page, then\nfor inv in invoices: …",
    lazy: "for inv in client.invoices():  # a generator\n    …",
  },
  typescript: {
    eager: "const invoices = await client.listAll(); // every page, then\nfor (const inv of invoices) { … }",
    lazy: "for await (const inv of client.invoices()) { … } // async generator",
  },
  rust: {
    eager: "let invoices: Vec<Invoice> = client.list_all()?; // every page, then\nfor inv in &invoices { … }",
    lazy: "for inv in client.invoices() { let inv = inv?; … } // impl Iterator",
  },
};

const fmt = (x: number) => x.toLocaleString("en-US");
const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function Strip({ total, size, run, design }: { total: number; size: number; run: Run; design: Design }) {
  const all = pages(total, size);
  const cells = Math.min(all, 40);
  const per = Math.ceil(all / cells);
  const failed = run.outcome === "failed" ? run.calls : null;
  return (
    <div>
      <span className="label">{fmt(all)} pages · {per > 1 ? `each square is ${per} pages` : "one square per page"}</span>
      <div className="iterator-strip" role="img" aria-label={`${run.calls} of ${all} pages fetched, ${run.held} held in memory at the end`}>
        {Array.from({ length: cells }, (_, i) => {
          const first = i * per + 1, last = Math.min(all, (i + 1) * per);
          let cls = "";
          if (failed && first <= failed && failed <= last) cls = "fail";
          else if (first <= run.calls) cls = design === "eager" || last >= run.calls ? "held" : "seen";
          return <i key={i} className={cls} />;
        })}
      </div>
    </div>
  );
}

function Side({ st, design, lang }: { st: State; design: Design; lang: Lang }) {
  const r = st.runs?.[design];
  return (
    <section className="pg-side" aria-label={design === "eager" ? "Load every page, then loop" : "Loop over an iterator"}>
      <header><h4>{design === "eager" ? "Load all, then loop" : "Iterator"}</h4></header>
      <pre className="iterator-code"><code>{CODE[lang][design]}</code></pre>
      {!r ? (
        <p className="pg-empty">Press Run to send the job through both designs.</p>
      ) : (
        <>
          <Strip total={st.runs!.total} size={st.runs!.pageSize} run={r} design={design} />
          <dl className="pg-stats">
            <div><dt>API calls</dt><dd>{fmt(r.calls)}</dd></div>
            <div className={r.outcome === "oom" ? "bad" : ""}><dt>Peak memory</dt><dd>{r.peakMb} MB</dd></div>
            <div className={r.firstMs === null ? "bad" : ""}><dt>First invoice after</dt><dd>{r.firstMs === null ? "never" : secs(r.firstMs)}</dd></div>
            <div className={r.duplicates ? "bad" : ""}><dt>Duplicates</dt><dd>{r.duplicates}</dd></div>
          </dl>
          <div className="iterator-mem" aria-hidden="true"><i style={{ width: `${Math.min(100, (r.peakMb / LIMIT_MB) * 100)}%` }} className={r.outcome === "oom" ? "bad" : ""} /></div>
          <p className={"iterator-say" + (r.outcome === "done" ? "" : " bad")}>
            {r.outcome === "oom" && `Killed: out of memory after ${fmt(r.calls)} pages (limit ${LIMIT_MB} MB). Not one invoice was processed.`}
            {r.outcome === "failed" && (design === "eager"
              ? `Page ${FAIL_PAGE} failed while loading. The loop never started: 0 invoices processed, and the pages already fetched are thrown away.`
              : `Page ${FAIL_PAGE} failed. ${fmt(r.processed)} invoices were already processed, and the job can resume from page ${r.resumeAt}.`)}
            {r.outcome === "done" && `${fmt(r.processed)} invoices processed in ${secs(r.totalMs)}.${r.duplicates ? ` ${r.duplicates} of them twice.` : ""}`}
          </p>
        </>
      )}
    </section>
  );
}

function PullPanel({ st, dispatch }: { st: State; dispatch: (a: Parameters<typeof step>[1]) => void }) {
  const p = st.pull;
  const need = needed(st.job, st.total);
  return (
    <div className="pg-card">
      <span className="label">Drive the iterator yourself · each click is one turn of the loop</span>
      <div className="pg-actions">
        <PgButton onClick={() => dispatch({ type: "pull" })} disabled={p.done}>next()</PgButton>
        {[5, 50].map((k) => (
          <PgButton key={k} disabled={p.done} onClick={() => { for (let i = 0; i < k; i++) dispatch({ type: "pull" }); }}>next() ×{k}</PgButton>
        ))}
      </div>
      <p className="iterator-say">
        {p.current === null && !p.done && "Nothing fetched yet. Creating the iterator costs nothing; the first next() fetches page 1."}
        {p.current !== null && (
          <>Invoice #{fmt(p.current + 1)}: ${fmt(amount(p.current))}{p.current === BIG_AT ? " (over $5,000)" : ""}. Pages fetched so far: <b>{p.pagesFetched}</b>. {p.current % st.pageSize === 0 ? "That call crossed into a new page, so the iterator fetched it." : "Served from the page already in memory, no API call."}</>
        )}
        {p.done && ` The job has what it needs after ${fmt(need)} invoices, so the loop stops and page ${p.pagesFetched + 1} is never requested.`}
      </p>
    </div>
  );
}

function Result({ st }: { st: State }) {
  const R = st.runs;
  if (!R) return null;
  const e = R.eager, l = R.lazy;
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What this run showed</span>
      <p>
        <b>{JOBS[R.job].label}</b>, {fmt(R.total)} invoices, {R.pageSize} per page. Load-all made {fmt(e.calls)} calls, peaked at {e.peakMb} MB and {e.firstMs === null ? "never reached the loop" : `showed the first invoice after ${secs(e.firstMs)}`}. The iterator made {fmt(l.calls)} calls, peaked at {l.peakMb} MB and showed the first invoice after {secs(l.firstMs ?? 0)}.
      </p>
      <p className="pg-takeaway">
        {R.inserts && R.paging === "offset" && l.duplicates
          ? "Both designs read the same pages, and both saw duplicates. Offset paging shifts when new rows arrive at the top. The iterator hides the paging from the loop, so it is the iterator's job to page by cursor."
          : R.job !== "export"
            ? "The loop asked for only what it needed, and the iterator fetched only that. Load-all paid for every page before the loop even started."
            : "Reading everything costs the same number of calls either way. The iterator still holds one page instead of all of them, and a failure loses only the page in flight."}
      </p>
    </div>
  );
}

export default function IteratorPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch } = useModel(step, init);
  const R = st.runs;
  const revealed = !!R && R.job === "first-big";

  return (
    <PgFrame title="Walk 20,000 invoices, 100 at a time" onReset={() => dispatch({ type: "reset" })}>
      <style>{CSS}</style>
      <PgPredict
        question="Find the first invoice over $5,000 among 20,000, fetched 100 per page. It is on page 3. How many pages does each design fetch?"
        options={[
          { value: "same-all", label: "Both fetch all 200" },
          { value: "same-3", label: "Both fetch 3" },
          { value: "split", label: "Load-all fetches 200, the iterator 3" },
        ]}
        value={st.prediction}
        onChange={(v) => dispatch({ type: "predict", value: v })}
        revealed={revealed}
        answer="split"
        explain="Load-all must finish building its list before the loop runs, so it fetches every page. The iterator fetches a page only when the loop asks for an invoice on it, and the loop stops at the match on page 3."
      />

      <div className="pg-card">
        <span className="label">The job</span>
        <PgChoice<Job> label="Job" value={st.job} onChange={(j) => dispatch({ type: "setJob", job: j })}
          options={(Object.keys(JOBS) as Job[]).map((j) => ({ value: j, label: JOBS[j].label, note: JOBS[j].what }))} />
        <div className="iterator-row">
          <span className="label">Invoices</span>
          <PgChoice label="Invoices" value={String(st.total)} onChange={(v) => dispatch({ type: "setTotal", total: Number(v) as State["total"] })}
            options={TOTALS.map((t) => ({ value: String(t), label: fmt(t) }))} />
          <span className="label">Per page</span>
          <PgChoice label="Per page" value={String(st.pageSize)} onChange={(v) => dispatch({ type: "setPageSize", size: Number(v) as State["pageSize"] })}
            options={PAGE_SIZES.map((t) => ({ value: String(t), label: String(t) }))} />
        </div>
        <div className="iterator-row">
          <span className="label">Break it</span>
          <label className="iterator-check"><input type="checkbox" checked={st.failing} onChange={(e) => dispatch({ type: "setFailing", on: e.target.checked })} /> API fails on page {FAIL_PAGE}</label>
          <label className="iterator-check"><input type="checkbox" checked={st.inserts} onChange={(e) => dispatch({ type: "setInserts", on: e.target.checked })} /> New invoices arrive while walking</label>
          {st.inserts && (
            <PgChoice<Paging> label="Paging" value={st.paging} onChange={(p) => dispatch({ type: "setPaging", paging: p })}
              options={[{ value: "offset", label: "?offset=200", note: "Skip N rows" }, { value: "cursor", label: "?after=inv_8812", note: "Continue after the last row seen" }]} />
          )}
        </div>
        <div className="pg-actions"><PgButton primary onClick={() => dispatch({ type: "run" })}>Run the job both ways</PgButton></div>
      </div>

      <div className="pg-sides">
        <Side st={st} design="eager" lang={lang} />
        <Side st={st} design="lazy" lang={lang} />
      </div>

      <PullPanel st={st} dispatch={dispatch} />

      <div className="pg-card">
        <span className="label">Challenges</span>
        <ol className="iterator-ch">
          {CHALLENGES.map((c) => (
            <li key={c.id} className={challengeDone(st, c.id) ? "done" : ""}>{challengeDone(st, c.id) ? "✓ " : ""}{c.text}</li>
          ))}
        </ol>
      </div>

      <Result st={st} />

      <PgSources links={[
        { title: "Go's iter package", href: "https://pkg.go.dev/iter" },
        { title: "Python Tutor's step-through of generators", href: "https://pythontutor.com/" },
        { title: "Slack's write-up on cursor pagination", href: "https://slack.engineering/evolving-api-pagination-at-slack/" },
      ]} />
    </PgFrame>
  );
}

const CSS = `
.iterator-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.iterator-check { display: flex; gap: 6px; align-items: center; font-size: .92rem; }
.iterator-code { margin: 0; border: 1px solid var(--line); background: var(--surface); padding: 6px 8px; overflow-x: auto; }
.iterator-code code { font-size: .68rem; background: none; padding: 0; white-space: pre-wrap; word-break: break-word; }
.iterator-strip { display: grid; grid-template-columns: repeat(20, minmax(0, 1fr)); gap: 2px; margin-top: 4px; }
.iterator-strip i { display: block; aspect-ratio: 1; border: 1px solid var(--line); background: var(--bg); }
.iterator-strip i.held { background: var(--accent); border-color: var(--accent); }
.iterator-strip i.seen { background: var(--surface-2); }
.iterator-strip i.fail { background: var(--pain); border-color: var(--pain); }
.iterator-mem { height: 6px; border: 1px solid var(--line); background: var(--surface); }
.iterator-mem i { display: block; height: 100%; background: var(--accent); }
.iterator-mem i.bad { background: var(--pain); }
.iterator-say { margin: 0; font-size: .95rem; }
.iterator-say.bad { color: var(--pain); }
.iterator-ch { margin: 0; padding-left: 1.2em; display: grid; gap: 4px; font-size: .95rem; }
.iterator-ch li.done { color: var(--good); }
`;
