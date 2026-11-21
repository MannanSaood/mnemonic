"use client";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgLog, PgPredict, PgSources, useModel } from "../kit";
import {
  APPROACHES, CORRUPT_NIGHT, FIX_NIGHT, NIGHTS, available, finished, init, step, summarize,
  type Approach, type Design, type NightResult, type Summary,
} from "./model";

/* ---------------- the platform's run(), in the reader's language ---------------- */

const RUN: Record<Lang, Record<Design, string[]>> = {
  go: {
    switch: ["func (j *ExportJob) Run(rows RowSource, out io.Writer) error {", "    var w RowWriter", "    switch j.Format {", '    case "csv": w = NewCSVWriter(out)', '    case "json": w = NewJSONWriter(out)', '    case "parquet": w = NewParquetWriter(out, j.Schema)', "    }", "    return j.copyAndUpload(rows, w)", "}"],
    hook: ["func (j *ExportJob) Run(rows RowSource, out io.Writer) error {", "    w := j.NewWriter(out, j.Schema) // the hook", "    return j.copyAndUpload(rows, w)", "}"],
  },
  python: {
    switch: ["def run(self, rows, out):", '    if self.format == "csv": w = CsvWriter(out)', '    elif self.format == "json": w = JsonWriter(out)', '    elif self.format == "parquet": w = ParquetWriter(out, self.schema)', "    self.copy_and_upload(rows, w)"],
    hook: ["def run(self, rows, out):", "    w = self.create_writer(out)  # the hook", "    self.copy_and_upload(rows, w)"],
  },
  typescript: {
    switch: ["run(rows: Rows, out: Writable) {", "  let w: RowWriter;", "  switch (this.format) {", '    case "csv": w = new CsvWriter(out); break;', '    case "json": w = new JsonWriter(out); break;', '    case "parquet": w = new ParquetWriter(out, this.schema); break;', "  }", "  return this.copyAndUpload(rows, w);", "}"],
    hook: ["run(rows: Rows, out: Writable) {", "  const w = this.createWriter(out); // the hook", "  return this.copyAndUpload(rows, w);", "}"],
  },
  rust: {
    switch: ["fn run(&self, rows: Rows, out: Box<dyn Write>) -> io::Result<()> {", "    let w: Box<dyn RowWriter> = match self.format.as_str() {", '        "csv" => Box::new(CsvWriter::new(out)),', '        "json" => Box::new(JsonWriter::new(out)),', '        "parquet" => Box::new(ParquetWriter::new(out, &self.schema)),', "        _ => return Err(unknown_format()),", "    };", "    self.copy_and_upload(rows, w)", "}"],
    hook: ["fn run(&self, rows: Rows, out: Box<dyn Write>) -> io::Result<()> {", "    let w = self.create_writer(out); // the hook", "    self.copy_and_upload(rows, w)", "}"],
  },
};

const HOOK_LINE: Record<Lang, string> = {
  go: "job := &ExportJob{Schema: s, NewWriter: NewXLSXWriter}",
  python: "class XlsxExport(ExportJob):\n    def create_writer(self, out): return XlsxWriter(out)",
  typescript: "class XlsxExport extends ExportJob {\n  protected createWriter(out: Writable) { return new XlsxWriter(out); }\n}",
  rust: "impl ExportJob for XlsxExport {\n    fn create_writer(&self, out: Box<dyn Write>) -> Box<dyn RowWriter> { Box::new(XlsxWriter::new(out)) }\n}",
};

const INFO: Record<Approach, { title: string; does: string }> = {
  pr: { title: "Ask platform for a case", does: "Open a PR on their job. They review, merge and release it." },
  fork: { title: "Copy run() into your repo", does: "Paste the platform's run() into Billing's code and add an xlsx case. Ships today." },
  override: { title: "Override createWriter()", does: "Plug your own writer in through the job's creation hook. The rest of run() stays platform's." },
};

const RESULT_LABEL: Record<NightResult, string> = { missing: "no export", ok: "delivered", retried: "caught + retried", corrupt: "broken file sent" };

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Takeaway({ done }: { done: Summary[] }) {
  if (!done.length) return null;
  const by = Object.fromEntries(done.map((d) => [d.approach, d])) as Partial<Record<Approach, Summary>>;
  const parts: string[] = [];
  if (by.pr) parts.push(`Asking platform cost ${n(by.pr.missing, "night")} with no XLSX export while the PR waited.`);
  if (by.fork) parts.push(`The copy shipped at once, but you now own ${by.fork.copied} copied lines, and ${n(by.fork.corrupt, "broken file")} reached the customer because the copy never got night ${FIX_NIGHT}'s fix.`);
  if (by.override) parts.push(`Overriding createWriter() shipped on night 1 with ${by.override.owned} lines of your own, and night ${FIX_NIGHT}'s fix reached you without you touching anything.`);
  const missing = APPROACHES.filter((a) => !by[a]);
  return (
    <div className="pg-result" aria-live="polite">
      <span className="label">What your runs showed</span>
      <div className="fm-scroll"><table className="fm-table">
        <thead><tr><th>Approach</th><th>Delivered</th><th>No export</th><th>Broken sent</th><th>Lines you own</th></tr></thead>
        <tbody>
          {done.map((d) => (
            <tr key={d.approach}>
              <th scope="row">{INFO[d.approach].title}</th>
              <td>{d.delivered}/{NIGHTS}</td>
              <td className={d.missing ? "bad" : ""}>{d.missing}</td>
              <td className={d.corrupt ? "bad" : ""}>{d.corrupt}</td>
              <td>{d.owned}{d.copied ? ` (${d.copied} copied)` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {parts.map((p) => <p key={p}>{p}</p>)}
      <p className="pg-takeaway">
        {by.override
          ? "A factory method moves one decision, which class to create, to whoever extends the job. Everything else in run() stays shared, so it keeps improving for you."
          : missing.includes("override")
            ? "Switch the platform design to the createWriter() hook and try the third approach."
            : "Try the remaining approaches to compare."}
      </p>
    </div>
  );
}

export default function FactoryMethodPlayground() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const r = st.run;
  const last = r?.nights.length ?? 0;
  const live = r ? summarize(r) : null;
  const entries = r ? [...r.nights].reverse().slice(0, 4).map((x) => ({ id: x.n, ok: x.result === "ok" || x.result === "retried", text: x.text, path: x.path })) : [];

  return (
    <PgFrame title="Ship XLSX on a job you do not own" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">Your task · Billing team</span>
        <p>Finance needs a nightly <b>XLSX</b> export from tonight. The export job belongs to the platform team: you cannot edit it, only use it. On night {FIX_NIGHT} platform ships a fix to <code>run()</code> that verifies each upload. On night {CORRUPT_NIGHT} an upload gets truncated.</p>
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Platform&apos;s job · read only</span>
          <PgChoice<Design> label="Platform design" value={st.design} onChange={(d) => dispatch({ type: "design", design: d })}
            options={[{ value: "switch", label: "Writer chosen by a switch" }, { value: "hook", label: "createWriter() hook" }]} />
          <div className="pgc" aria-label="Platform's run method">
            {RUN[lang][st.design].map((l, i) => (
              <div key={i} className={"pgc-line" + (l.includes("hook") ? " new" : "")}><code>{l}</code></div>
            ))}
          </div>
          {st.design === "hook" && (
            <>
              <span className="label">What Billing would write</span>
              <div className="pgc">{HOOK_LINE[lang].split("\n").map((l, i) => <div key={i} className="pgc-line new"><code>{l}</code></div>)}</div>
            </>
          )}
        </div>

        <div className="pg-card">
          <PgPredict<Approach>
            question="Which approach delivers XLSX from night 1 and also picks up platform's night-8 fix?"
            options={APPROACHES.map((a) => ({ value: a, label: INFO[a].title }))}
            value={st.prediction}
            onChange={(a) => dispatch({ type: "predict", approach: a })}
            revealed={st.done.length > 0}
            answer="override"
            explain="Only the override keeps platform's run() as the code that runs. The PR is safe but waits, and the copy ships fast but freezes run() at the day you copied it."
          />
          <span className="label">How will Billing ship it?</span>
          <div className="fm-approaches" role="group" aria-label="Approach">
            {APPROACHES.map((a) => {
              const ok = available(st.design, a);
              return (
                <button key={a} className={"fm-approach" + (r?.approach === a ? " on" : "")} aria-pressed={r?.approach === a}
                  disabled={!ok} onClick={() => dispatch({ type: "choose", approach: a })}>
                  <b>{INFO[a].title}</b>
                  <span>{ok ? INFO[a].does : "Not possible: there is no creation hook. The writer is picked inside run()."}</span>
                </button>
              );
            })}
          </div>
          <label className="fm-wait">
            <span className="label">Platform review + release: {n(st.wait, "day")}</span>
            <input type="range" min={1} max={NIGHTS} value={st.wait} onChange={(e) => dispatch({ type: "wait", days: Number(e.target.value) })} />
          </label>
        </div>
      </div>

      <div className="pg-card">
        <div className="fm-head">
          <span className="label">{r ? `${INFO[r.approach].title} · nights run: ${last}/${NIGHTS}` : "Pick an approach, then run the nights"}</span>
          <div className="pg-actions">
            <PgButton onClick={() => dispatch({ type: "night" })} disabled={!r || finished(r)}>Run next night</PgButton>
            <PgButton primary onClick={() => dispatch({ type: "finish" })} disabled={!r || finished(r)}>Run all {NIGHTS}</PgButton>
          </div>
        </div>
        <ol className="fm-strip" aria-label="Nightly results">
          {Array.from({ length: NIGHTS }, (_, i) => {
            const x = r?.nights[i];
            return (
              <li key={i} className={"fm-night " + (x ? x.result : "todo") + (reduced ? "" : " anim")} title={x ? RESULT_LABEL[x.result] : "not run"}>
                <span className="fm-n">{i + 1}</span>
                <span className="fm-mark">{i + 1 === FIX_NIGHT ? "fix" : i + 1 === CORRUPT_NIGHT ? "trunc" : ""}</span>
                <span className="sr">{x ? RESULT_LABEL[x.result] : "not run"}</span>
              </li>
            );
          })}
        </ol>
        <p className="muted">Teal: delivered. Orange: no export, or a broken file sent. &ldquo;fix&rdquo;: platform ships the checksum check. &ldquo;trunc&rdquo;: the upload is truncated.</p>
        {live && (
          <dl className="pg-stats">
            <div><dt>Delivered</dt><dd>{live.delivered}</dd></div>
            <div className={live.missing ? "bad" : ""}><dt>No export</dt><dd>{live.missing}</dd></div>
            <div className={live.corrupt ? "bad" : ""}><dt>Broken sent</dt><dd>{live.corrupt}</dd></div>
            <div><dt>Lines you own</dt><dd>{live.owned}</dd></div>
          </dl>
        )}
        <PgLog entries={entries} empty="No nights run yet." reduced={reduced} />
      </div>

      <Takeaway done={st.done} />

      <PgSources links={[
        { title: "Refactoring.Guru: Factory Method", href: "https://refactoring.guru/design-patterns/factory-method" },
        { title: "Django's get_form_class() hook", href: "https://docs.djangoproject.com/en/5.1/ref/class-based-views/mixins-editing/" },
        { title: "Fowler: Replace Constructor with Factory Function", href: "https://refactoring.com/catalog/replaceConstructorWithFactoryFunction.html" },
      ]} />

      <style>{`
        .fm-approaches { display: grid; gap: 6px; }
        .fm-approach { text-align: left; border: 1px solid var(--line); background: var(--surface); padding: 6px 10px; display: grid; gap: 2px; }
        .fm-approach span { font-size: .88rem; color: var(--ink-2); }
        .fm-approach.on { border-color: var(--accent); box-shadow: inset 3px 0 0 var(--accent); }
        .fm-approach:disabled { opacity: .55; cursor: default; }
        .fm-wait { display: grid; gap: 4px; }
        .fm-wait input { width: 100%; accent-color: var(--accent); }
        .fm-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
        .fm-strip { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 2px; }
        .fm-night { border: 1px solid var(--line); background: var(--surface); min-height: 44px; display: grid; align-content: space-between; padding: 2px 3px; font-family: var(--f-code); font-size: .6rem; }
        .fm-night.ok, .fm-night.retried { background: var(--good-bg); border-color: var(--good); color: var(--good); }
        .fm-night.missing, .fm-night.corrupt { background: var(--pain-bg); border-color: var(--pain); color: var(--pain); }
        .fm-night.anim:not(.todo) { animation: pg-hop .3s var(--ease) both; }
        .fm-mark { text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); }
        .fm-scroll { overflow-x: auto; max-width: 100%; }
        .fm-table { width: 100%; border-collapse: collapse; font-size: .85rem; }
        .fm-table th, .fm-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; }
        .fm-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .fm-table td.bad { color: var(--pain); font-weight: 600; }
        .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
        @media (max-width: 560px) { .fm-strip { grid-template-columns: repeat(7, minmax(0, 1fr)); } .fm-table { font-size: .75rem; } }
        @media (prefers-reduced-motion: reduce) { .fm-night.anim { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
