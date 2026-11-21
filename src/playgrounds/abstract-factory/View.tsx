"use client";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CLOUD_NAME, OUTCOME_TEXT, PRODUCT, SLOTS, allWirings, init, isFamily, key, space, step,
  type Cloud, type Design, type Outcome, type Slot, type State, type Wiring,
} from "./model";

const SLOT_LABEL: Record<Slot, string> = { storage: "Object storage", queue: "Queue", secrets: "Secrets" };
const SHORT: Record<Cloud, Record<Slot, string>> = {
  aws: { storage: "S3", queue: "SQS", secrets: "ASM" },
  gcp: { storage: "GCS", queue: "PS", secrets: "GSM" },
  azure: { storage: "Blob", queue: "AQ", secrets: "KV" },
};
const OUTCOME_SHORT: Record<Outcome, string> = { processed: "works", "upload-error": "loud error", silent: "silent", crashloop: "crash loop" };

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

function Board({ st, set }: { st: State; set: (slot: Slot, c: Cloud) => void }) {
  const fam = st.design === "factory";
  return (
    <div className={"af-board" + (fam ? " fam" : "")} role="group" aria-label="Wiring">
      <div className="af-row af-headrow" aria-hidden="true">
        <span />
        {st.clouds.map((c) => <span key={c} className="label">{CLOUD_NAME[c]}</span>)}
      </div>
      {SLOTS.map((slot) => (
        <div key={slot} className="af-row">
          <span className="label">{SLOT_LABEL[slot]}</span>
          {st.clouds.map((c) => {
            const on = st.wiring[slot] === c;
            return (
              <button key={c} className={"af-cell" + (on ? " on" : "")} aria-pressed={on}
                aria-label={`${SLOT_LABEL[slot]}: ${PRODUCT[c][slot]}`} onClick={() => set(slot, c)}>
                {PRODUCT[c][slot]}
              </button>
            );
          })}
        </div>
      ))}
      <p className="muted">
        {fam
          ? "One setting, CLOUD, picks a factory. Click any cell: the whole column moves, because one factory makes all three."
          : "Three settings: STORAGE, QUEUE and SECRETS. Click any cell to change that one setting."}
      </p>
    </div>
  );
}

function WiringMap({ st, set }: { st: State; set: (w: Wiring) => void }) {
  const all = allWirings(st);
  const tried = st.tried[st.design];
  return (
    <div className="af-map" role="group" aria-label="Every wiring this design allows">
      {all.map((w) => {
        const k = key(w), out = tried[k], cur = k === key(st.wiring);
        const name = SLOTS.map((s) => SHORT[w[s]][s]).join("·");
        return (
          <button key={k} className={"af-dot " + (out ?? "untried") + (cur ? " cur" : "")} onClick={() => set(w)}
            title={`${SLOTS.map((s) => PRODUCT[w[s]][s]).join(" + ")}: ${out ? OUTCOME_SHORT[out] : "not tried"}`}>
            <span>{name}</span>
            <small>{out ? OUTCOME_SHORT[out] : "?"}</small>
          </button>
        );
      })}
    </div>
  );
}

export default function AbstractFactoryPlayground() {
  const { state: st, dispatch, reduced } = useModel(step, init);
  const sp = space(st);
  const tried = Object.values(st.tried.settings);
  const silent = tried.filter((o) => o === "silent").length;
  const t = st.last;
  const setWiring = (w: Wiring) => {
    if (st.design === "factory") dispatch({ type: "set", slot: "storage", cloud: w.storage });
    else for (const s of SLOTS) dispatch({ type: "set", slot: s, cloud: w[s] });
  };

  return (
    <PgFrame title="Wire a service to one cloud" onReset={() => dispatch({ type: "reset" })}>
      <div className="pg-req">
        <span className="label">The situation</span>
        <p>Staging moved from AWS to GCP last week. Uploads go to object storage, storage notifies a queue, and a worker reads its database password from the secrets store before it processes the file. Somebody updated two of the three settings.</p>
      </div>

      <div className="af-controls">
        <PgChoice<Design> label="Design" value={st.design} onChange={(d) => dispatch({ type: "design", design: d })}
          options={[{ value: "settings", label: "Three settings" }, { value: "factory", label: "One cloud factory" }]} />
        <PgChoice<Cloud> label="Service runs in" value={st.env} onChange={(c) => dispatch({ type: "env", env: c })}
          options={st.clouds.map((c) => ({ value: c, label: `runs in ${CLOUD_NAME[c]}` }))} />
      </div>

      <div className="pg-grid">
        <div className="pg-card">
          <span className="label">Wiring</span>
          <Board st={st} set={(slot, cloud) => dispatch({ type: "set", slot, cloud })} />
          <PgButton primary onClick={() => dispatch({ type: "send" })}>Send an upload</PgButton>
        </div>

        <div className="pg-card">
          <PgPredict<Outcome>
            question="Staging runs in GCP with GCS storage, an SQS queue and GCP secrets. A user uploads a file. What do they see?"
            options={[
              { value: "upload-error", label: "An error" },
              { value: "processed", label: "It gets processed" },
              { value: "silent", label: "Success, then nothing" },
            ]}
            value={st.prediction}
            onChange={(o) => dispatch({ type: "predict", outcome: o })}
            revealed={st.sent > 0}
            answer="silent"
            explain="GCS accepts the file, so the upload returns 200. But GCS only notifies Pub/Sub, so the SQS queue never hears about it. No error is logged anywhere: the worst kind of failure."
          />
          <span className="label">Last upload</span>
          {t ? (
            <div className={"pg-entry " + (t.outcome === "processed" ? "ok" : "fail") + (reduced ? "" : " fresh")} aria-live="polite">
              <div className="pg-path" aria-hidden="true">
                {t.hops.map((h, j) => <span key={j} className={h.ok ? "" : "af-bad"} style={{ animationDelay: `${j * 140}ms` }}>{h.label} {h.ok ? "✓" : "✗"}</span>)}
              </div>
              <p>{t.hops[t.hops.length - 1].note}</p>
              <p><b>{OUTCOME_TEXT[t.outcome]}</b></p>
            </div>
          ) : <p className="pg-empty">Nothing sent with this wiring yet.</p>}
        </div>
      </div>

      <div className="pg-card">
        <span className="label">Every wiring this design allows · click one to load it, then send</span>
        <WiringMap st={st} set={setWiring} />
        <dl className="pg-stats">
          <div><dt>Wirings allowed</dt><dd>{sp.possible}</dd></div>
          <div><dt>Work in {CLOUD_NAME[st.env]}</dt><dd>{sp.working}</dd></div>
          <div className={st.design === "settings" && !isFamily(st.wiring) ? "bad" : ""}><dt>Current wiring</dt><dd>{isFamily(st.wiring) ? "one family" : "mixed"}</dd></div>
          <div className={silent ? "bad" : ""}><dt>Silent failures found</dt><dd>{silent}</dd></div>
        </dl>
      </div>

      <div className="pg-card">
        <span className="label">Change requests</span>
        <div className="pg-actions">
          <PgButton onClick={() => dispatch({ type: "addAzure" })} disabled={st.clouds.includes("azure")}>A customer needs Azure</PgButton>
          <PgButton onClick={() => dispatch({ type: "addCache" })} disabled={!!st.cacheCost}>Every cloud needs a cache</PgButton>
        </div>
        {(st.azureCost || st.cacheCost) && (
          <div className="af-scroll">
            <table className="af-table">
              <thead><tr><th>Request</th><th>Three settings</th><th>One cloud factory</th></tr></thead>
              <tbody>
                {st.azureCost && <tr><th scope="row">Add Azure</th><td>{st.azureCost.settings.text}</td><td className="good">{st.azureCost.factory.text}</td></tr>}
                {st.cacheCost && <tr><th scope="row">Add a cache</th><td>{st.cacheCost.settings.text}</td><td className="bad">{st.cacheCost.factory.text}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(tried.length > 0 || st.azureCost) && (
        <div className="pg-result" aria-live="polite">
          <span className="label">What your wiring showed</span>
          <p>
            With three settings and {n(st.clouds.length, "cloud")}, the config can express {st.clouds.length ** 3} wirings and exactly 1 works in {CLOUD_NAME[st.env]}.
            You tried {n(tried.length, "of them", "of them")}{tried.length ? `: ${tried.filter((o) => o === "processed").length} worked, ${silent} failed silently` : ""}.
            With one factory per cloud the config can express {st.clouds.length}, and every one is a whole family.
          </p>
          <p className="pg-takeaway">
            Abstract Factory turns &ldquo;these three must match&rdquo; from a rule people have to remember into a shape the code cannot break.
            {st.cacheCost ? " The price shows when a new kind of product arrives: every factory has to learn to make it." : " Now try the cache request to see what it costs."}
          </p>
        </div>
      )}

      <PgSources links={[
        { title: "Refactoring.Guru: Abstract Factory", href: "https://refactoring.guru/design-patterns/abstract-factory" },
        { title: "Go CDK portable cloud APIs", href: "https://gocloud.dev/concepts/urls/" },
        { title: "Amazon S3 event notification destinations", href: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/EventNotifications.html" },
      ]} />

      <style>{`
        .af-controls { display: flex; flex-wrap: wrap; gap: 8px; }
        .af-board { display: grid; gap: 4px; }
        .af-row { display: grid; grid-template-columns: 7.5em repeat(${st.clouds.length}, minmax(0, 1fr)); gap: 4px; align-items: center; }
        .af-cell { border: 1px solid var(--line); background: var(--surface); padding: 6px 4px; font-family: var(--f-code); font-size: .72rem; transition: background .2s var(--ease), border-color .2s var(--ease); }
        .af-cell.on { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
        .af-board.fam .af-cell.on { box-shadow: 0 0 0 2px var(--accent); }
        .af-bad { border-color: var(--pain) !important; color: var(--pain); }
        .af-map { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 4px; }
        .af-dot { border: 1px solid var(--line); background: var(--surface); padding: 4px; display: grid; gap: 1px; text-align: left; font-family: var(--f-code); font-size: .64rem; }
        .af-dot small { font-size: .58rem; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-2); }
        .af-dot.processed { background: var(--good-bg); border-color: var(--good); }
        .af-dot.processed small { color: var(--good); }
        .af-dot.silent, .af-dot.upload-error, .af-dot.crashloop { background: var(--pain-bg); border-color: var(--pain); }
        .af-dot.silent small, .af-dot.upload-error small, .af-dot.crashloop small { color: var(--pain); }
        .af-dot.cur { outline: 2px solid var(--accent); outline-offset: 1px; }
        .af-scroll { overflow-x: auto; }
        .af-table { width: 100%; border-collapse: collapse; font-size: .88rem; }
        .af-table th, .af-table td { border: 1px solid var(--line); padding: 4px 6px; text-align: left; vertical-align: top; }
        .af-table thead th { font-family: var(--f-code); font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .af-table td.good { color: var(--good); }
        .af-table td.bad { color: var(--pain); }
        @media (max-width: 560px) { .af-row { grid-template-columns: 5.5em repeat(${st.clouds.length}, minmax(0, 1fr)); } }
        @media (prefers-reduced-motion: reduce) { .af-cell { transition: none; } }
      `}</style>
    </PgFrame>
  );
}
