"use client";
import { useState } from "react";
import { usePrefs } from "@/components/Prefs";
import type { Lang } from "@/lib/types";
import { PgButton, PgChoice, PgFrame, PgPredict, PgSources, useModel } from "../kit";
import {
  CHECKS, CHECK_NAME, RTTS, goals, init, step,
  type Attacker, type BreakKey, type CheckId, type Resume, type Rtt, type Run, type Version,
} from "./model";

/* ---------------- what each client library says (message shapes, shortened) ---------------- */

const LIB: Record<Lang, string> = { go: "Go crypto/tls", python: "Python ssl", typescript: "Node tls", rust: "rustls" };

function errorText(r: Run, lang: Lang): string {
  const c = r.failed;
  if (!c) return "";
  if (c === "chain") {
    const why = r.chainWhy;
    return {
      go: "tls: failed to verify certificate: x509: certificate signed by unknown authority",
      python: `ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: ${why === "intermediate" ? "unable to get local issuer certificate" : why === "self" ? "self-signed certificate" : "self-signed certificate in certificate chain"}`,
      typescript: why === "intermediate" ? "Error: unable to verify the first certificate (UNABLE_TO_VERIFY_LEAF_SIGNATURE)" : why === "self" ? "Error: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)" : "Error: self-signed certificate in certificate chain (SELF_SIGNED_CERT_IN_CHAIN)",
      rust: "invalid peer certificate: UnknownIssuer",
    }[lang];
  }
  if (c === "dates") return {
    go: "tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time … is after …",
    python: "ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: certificate has expired",
    typescript: "Error: certificate has expired (CERT_HAS_EXPIRED)",
    rust: "invalid peer certificate: Expired",
  }[lang];
  if (c === "name") return {
    go: "tls: failed to verify certificate: x509: certificate is valid for www.example.com, not api.example.com",
    python: "ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: Hostname mismatch, certificate is not valid for 'api.example.com'.",
    typescript: "Error [ERR_TLS_CERT_ALTNAME_INVALID]: Hostname/IP does not match certificate's altnames: Host: api.example.com. is not in the cert's altnames: DNS:www.example.com",
    rust: "invalid peer certificate: NotValidForName",
  }[lang];
  return {
    go: "tls: invalid signature by the server certificate: ECDSA verification failure",
    python: "ssl.SSLError: [SSL: BAD_SIGNATURE] bad signature",
    typescript: "Error: … bad signature (ERR_SSL_BAD_SIGNATURE)",
    rust: "invalid peer certificate: BadSignature",
  }[lang];
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
const peerName = (r: Run) => (r.attacker === "none" ? "server" : "attacker");

/* ---------------- the message timeline ---------------- */

function Timeline({ r, reduced }: { r: Run; reduced: boolean }) {
  const W = 640, cx = 90, sx = W - 90, legH = 34, top = 34;
  const legs = Math.max(...r.msgs.map((m) => m.leg)) + 1;
  const byLeg = Array.from({ length: legs }, (_, i) => r.msgs.filter((m) => m.leg === i));
  const H = top + legs * legH + 16;
  const evil = r.attacker !== "none";
  return (
    <svg className="tls-tl" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`TLS ${r.version} ${r.resumed ? "resumed " : ""}handshake: ${r.requestRtts === null ? "the request was never sent" : `request sent after ${n(r.requestRtts, "round trip")}`}.`}>
      <text className="tls-lane" x={cx} y={14} textAnchor="middle">client</text>
      <text className={"tls-lane" + (evil ? " evil" : "")} x={sx} y={14} textAnchor="middle">{evil ? "attacker as api.example.com" : "api.example.com"}</text>
      <line className="tls-life" x1={cx} x2={cx} y1={22} y2={H - 4} />
      <line className={"tls-life" + (evil ? " evil" : "")} x1={sx} x2={sx} y1={22} y2={H - 4} />
      {Array.from({ length: Math.ceil(legs / 2) + 1 }, (_, k) => (
        <text key={k} className="tls-rtt" x={6} y={top + k * 2 * legH + 4}>{k * r.rtt} ms</text>
      ))}
      {byLeg.map((ms, i) => {
        const y0 = top + i * legH, y1 = y0 + legH - 6;
        const right = i % 2 === 0;
        return ms.map((m, j) => {
          const dy = j * 9;
          const x1 = right ? cx : sx, x2 = right ? sx - 4 : cx + 4;
          return (
            <g key={`${i}-${j}`} className={"tls-msg " + m.kind + (m.enc ? " enc" : " plain") + (reduced ? "" : " anim")} style={reduced ? undefined : { animationDelay: `${i * 120}ms` }}>
              <line x1={x1} y1={y0 + dy} x2={x2} y2={y1 + dy * 0.2} markerEnd="url(#tls-ah)" />
              <text x={(cx + sx) / 2} y={y0 + dy + (legH - 6) / 2 - 2} textAnchor="middle">{m.enc ? "▣ " : ""}{m.label}</text>
            </g>
          );
        });
      })}
      <defs>
        <marker id="tls-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="tls-ahead" />
        </marker>
      </defs>
    </svg>
  );
}

/* ---------------- the certificate chain the reader can break ---------------- */

function Chain({ breaks, attacker, dispatch }: { breaks: Record<BreakKey, boolean>; attacker: Attacker; dispatch: (a: { type: "break"; key: BreakKey }) => void }) {
  const own = attacker === "own";
  const Toggle = ({ k, label }: { k: BreakKey; label: string }) => (
    <button className="pg-btn tls-break" aria-pressed={breaks[k]} onClick={() => dispatch({ type: "break", key: k })} disabled={own}>{breaks[k] ? "✓ " : ""}{label}</button>
  );
  if (own) {
    return (
      <div className="tls-chain">
        <div className="tls-cert evil"><span className="label">Attacker&apos;s own certificate</span><b>CN api.example.com</b><span>issued by: the attacker&apos;s own CA</span><span>key: the attacker&apos;s, so it can sign</span></div>
      </div>
    );
  }
  return (
    <div className="tls-chain">
      <div className={"tls-cert" + (breaks.expired || breaks.wrongName ? " bad" : "")}>
        <span className="label">Leaf</span>
        <b>{breaks.wrongName ? "SAN www.example.com" : "SAN api.example.com"}</b>
        <span>{breaks.expired ? "expired yesterday" : "valid for 60 more days"}</span>
        <span>issued by: Example Issuing CA</span>
        <div className="pg-actions"><Toggle k="expired" label="Expire it" /><Toggle k="wrongName" label="Wrong name" /></div>
      </div>
      <div className={"tls-cert" + (breaks.noIntermediate ? " gone" : "")}>
        <span className="label">Intermediate</span>
        <b>Example Issuing CA</b>
        <span>{breaks.noIntermediate ? "not sent by the server" : "sent by the server"}</span>
        <span>issued by: Example Root</span>
        <div className="pg-actions"><Toggle k="noIntermediate" label="Server omits it" /></div>
      </div>
      <div className={"tls-cert" + (breaks.untrustedRoot ? " bad" : "")}>
        <span className="label">Root</span>
        <b>Example Root</b>
        <span>{breaks.untrustedRoot ? "not in the client's trust store" : "in the client's trust store"}</span>
        <span>self-signed</span>
        <div className="pg-actions"><Toggle k="untrustedRoot" label="Untrusted root" /></div>
      </div>
    </div>
  );
}

/* ---------------- the reader's own result ---------------- */

function Result({ runs, lang }: { runs: Run[]; lang: Lang }) {
  const r = runs[runs.length - 1];
  const lines: string[] = [];
  const full13 = runs.find((x) => x.version === "1.3" && !x.resumed && x.firstByteMs !== null);
  const full12 = runs.find((x) => x.version === "1.2" && !x.resumed && x.firstByteMs !== null);
  if (full13 && full12)
    lines.push(`On your paths, a new TLS 1.3 connection got its first response byte after ${full13.firstByteMs} ms (${full13.rtt} ms RTT) and TLS 1.2 after ${full12.firstByteMs} ms (${full12.rtt} ms RTT): 1.3 saves one full round trip per new connection.`);
  if (r.outcome === "refused")
    lines.push(`Run ${r.n} stopped at "${CHECK_NAME[r.failed!]}". The request and its API key never left the client. ${LIB[lang]} reported it loudly, which is the point.`);
  else if (r.outcome === "mitm")
    lines.push(`Run ${r.n} completed a perfect handshake with the attacker. The connection was encrypted, to the wrong party: the attacker decrypted the POST and read the bearer token. Encryption without the certificate checks protects you from nobody in the middle.`);
  else if (r.resumed)
    lines.push(`Run ${r.n} resumed with a ticket: no certificate was sent or checked, because the ticket proves this is the server from the earlier full handshake.${r.early ? " The request rode in the first flight as 0-RTT data, which an attacker can replay, so send only idempotent requests that way." : ""}`);
  else
    lines.push(`Run ${r.n}: ${r.verify ? "all four checks passed" : "the checks were skipped, and this time the peer happened to be the real server"}. The request left after ${n(r.requestRtts ?? 0, "round trip")}.`);
  return <p className="pg-takeaway">{lines.join(" ")}</p>;
}

/* ---------------- the playground ---------------- */

type G1 = "80" | "160" | "240" | "320";
type G2 = "chain" | "name" | "signature" | "none";

export default function TlsHandshake() {
  const { lang } = usePrefs();
  const { state: st, dispatch, reduced } = useModel(step, init);
  const [g1, setG1] = useState<G1 | null>(null);
  const [g2, setG2] = useState<G2 | null>(null);
  const r = st.runs[st.runs.length - 1];
  const g = goals(st.runs);
  const ok13 = st.runs.find((x) => x.version === "1.3" && !x.resumed && x.rtt === 80 && x.firstByteMs !== null);
  const copied = st.runs.find((x) => x.attacker === "copied" && x.verify);
  const reset = () => { setG1(null); setG2(null); dispatch({ type: "reset" }); };

  return (
    <PgFrame title="One handshake, traced and broken" onReset={reset}>
      <PgPredict<G1>
        question="A new connection over an 80 ms round trip, TLS 1.3, no resumption. When does the first byte of the response reach the client?"
        options={[{ value: "80", label: "80 ms" }, { value: "160", label: "160 ms" }, { value: "240", label: "240 ms" }, { value: "320", label: "320 ms" }]}
        value={g1} onChange={setG1} revealed={!!ok13} answer="240"
        explain={<>One round trip for TCP, one for TLS 1.3 (the client sends its key share in the very first message), one for the request itself: {ok13?.firstByteMs ?? 240} ms. TLS 1.2 needs a second handshake round trip, so 320 ms. Switch to 1.2 and connect to see it.</>}
      />
      {ok13 && (
        <PgPredict<G2>
          question="An attacker in the path sends the server's real, valid certificate chain, copied byte for byte. Verification is on. Which check fails?"
          options={[{ value: "chain", label: "The chain" }, { value: "name", label: "The name" }, { value: "signature", label: "The handshake signature" }, { value: "none", label: "None: it is a valid certificate" }]}
          value={g2} onChange={setG2} revealed={!!copied} answer="signature"
          explain={<>Certificates are public; anyone can copy them. The server must also sign this handshake&apos;s transcript with the private key that matches the leaf (CertificateVerify in 1.3, the signed ServerKeyExchange in 1.2). The attacker does not have that key, so the signature check fails with <code>{copied ? errorText(copied, lang) : "a bad signature error"}</code>.</>}
        />
      )}

      <div className="tls-controls">
        <div><span className="label">Version</span>
          <PgChoice<Version> label="TLS version" value={st.version} options={[{ value: "1.3", label: "TLS 1.3" }, { value: "1.2", label: "TLS 1.2" }]} onChange={(v) => dispatch({ type: "version", version: v })} />
        </div>
        <div><span className="label">Resumption{st.ticket ? " · ticket held" : " · no ticket yet"}</span>
          <PgChoice<Resume> label="Session resumption" value={st.resume}
            options={[{ value: "off", label: "Full" }, { value: "ticket", label: "Resume" }, { value: "early", label: "0-RTT", note: "TLS 1.3 only" }]}
            disabledOptions={st.version === "1.2" ? ["early"] : []}
            onChange={(v) => dispatch({ type: "resume", resume: v })} />
        </div>
        <div><span className="label">Round trip</span>
          <PgChoice<`${Rtt}`> label="Round-trip time" value={`${st.rtt}` as `${Rtt}`} options={RTTS.map((x) => ({ value: `${x}` as `${Rtt}`, label: `${x} ms` }))} onChange={(v) => dispatch({ type: "rtt", rtt: Number(v) as Rtt })} />
        </div>
      </div>

      <div className="tls-grid">
        <div className="tls-panel">
          <span className="label">Certificate chain the server sends</span>
          <Chain breaks={st.breaks} attacker={st.attacker} dispatch={dispatch} />
          <span className="label">In the path</span>
          <PgChoice<Attacker> label="Attacker in the path" value={st.attacker}
            options={[{ value: "none", label: "Nobody" }, { value: "own", label: "Attacker, own cert" }, { value: "copied", label: "Attacker, copied cert" }]}
            onChange={(v) => dispatch({ type: "attacker", attacker: v })} />
          <button className="pg-btn tls-break" aria-pressed={!st.verify} onClick={() => dispatch({ type: "verify" })}>{!st.verify ? "✓ Verification OFF" : "Turn verification off"}</button>
          <PgButton primary onClick={() => dispatch({ type: "connect" })}>Connect ▶</PgButton>
        </div>
        <div className="tls-panel">
          <span className="label">{r ? `Run ${r.n} · TLS ${r.version}${r.resumed ? (r.early ? " · 0-RTT" : " · resumed") : ""} · ${r.rtt} ms RTT` : "Handshake"}</span>
          {r ? <Timeline key={r.n} r={r} reduced={reduced} /> : <p className="pg-empty">Answer the question, then connect with nothing broken.</p>}
          {r && <p className="muted tls-legend">▣ encrypted · plain text is readable by anyone on the path, including the name in SNI{r.version === "1.2" && !r.resumed ? " and, in 1.2, the whole certificate" : ""}.</p>}
        </div>
      </div>

      {r && (
        <div className="tls-checks" aria-live="polite">
          <span className="label">What the client checked</span>
          <ol>
            {CHECKS.map((c: CheckId) => (
              <li key={c} className={r.checks[c]}>
                <span className="tls-mark">{r.checks[c] === "pass" ? "✓" : r.checks[c] === "fail" ? "✕" : r.checks[c] === "skipped" ? "–" : "·"}</span>
                {CHECK_NAME[c]}{r.checks[c] === "skipped" ? " (skipped: verification off)" : r.checks[c] === "not-run" ? (r.resumed ? " (not needed: resumed)" : " (not reached)") : ""}
              </li>
            ))}
          </ol>
          {r.failed && <pre className="tls-err"><span className="label">{LIB[lang]}</span>{"\n"}{errorText(r, lang)}</pre>}
          {r.outcome === "mitm" && <pre className="tls-err evil"><span className="label">What the attacker reads</span>{"\nPOST /v1/payouts\nAuthorization: Bearer sk_live_…\n{\"amount\": 125000, \"iban\": …}"}</pre>}
        </div>
      )}

      {r && (
        <dl className="pg-stats">
          <div><dt>Round trips to request</dt><dd>{r.requestRtts ?? "never sent"}</dd></div>
          <div><dt>First response byte</dt><dd>{r.firstByteMs === null ? "–" : `${r.firstByteMs} ms`}</dd></div>
          <div><dt>Talking to</dt><dd className={r.outcome === "mitm" ? "tls-bad" : ""}>{peerName(r)}</dd></div>
          <div className={r.outcome === "mitm" ? "bad" : ""}><dt>Outcome</dt><dd>{r.outcome === "ok" ? "connected" : r.outcome === "refused" ? "refused" : "intercepted"}</dd></div>
          <div><dt>Plain-text handshake msgs</dt><dd>{r.plaintext.length}</dd></div>
        </dl>
      )}

      {r && (
        <div className="pg-result">
          <span className="label">What your runs show</span>
          <Result runs={st.runs} lang={lang} />
        </div>
      )}

      {st.runs.length > 1 && (
        <div className="tls-table" role="region" aria-label="Your runs" tabIndex={0}>
          <table>
            <thead><tr><th>Run</th><th>TLS</th><th>RTT</th><th>Setup</th><th>First byte</th><th>Broken</th><th>Result</th></tr></thead>
            <tbody>
              {st.runs.slice(-6).map((x) => (
                <tr key={x.n} className={x.outcome}>
                  <td>{x.n}</td><td>{x.version}{x.resumed ? (x.early ? " 0-RTT" : " resumed") : ""}</td><td>{x.rtt} ms</td>
                  <td>{x.requestRtts === null ? "–" : `${x.requestRtts} RTT`}</td><td>{x.firstByteMs === null ? "–" : `${x.firstByteMs} ms`}</td>
                  <td>{[x.attacker !== "none" ? `attacker (${x.attacker})` : "", ...(Object.keys(x.breaks) as BreakKey[]).filter((k) => x.breaks[k]), x.verify ? "" : "verify off"].filter(Boolean).join(", ") || "nothing"}</td>
                  <td>{x.outcome === "refused" ? `✕ ${x.failed}` : x.outcome === "mitm" ? "read by attacker" : "ok"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pg-req">
        <span className="label">Challenges</span>
        <ul className="tls-goals">
          <li className={g.oneRtt ? "done" : ""}>{g.oneRtt ? "✓" : "○"} Send the request after a single round trip. (You need a ticket first.)</li>
          <li className={g.allChecks ? "done" : ""}>{g.allChecks ? "✓" : "○"} Make each of the four checks fail at least once.</li>
          <li className={g.stopped ? "done" : ""}>{g.stopped ? "✓" : "○"} Watch the copied-certificate attacker get stopped.</li>
          <li className={g.leaked ? "done" : ""}>{g.leaked ? "✓" : "○"} Find the one setting that lets an attacker read the request.</li>
        </ul>
      </div>

      <PgSources links={[
        { title: "The Illustrated TLS 1.3 Connection", href: "https://tls13.xargs.org/" },
        { title: "The Illustrated TLS 1.2 Connection", href: "https://tls12.xargs.org/" },
        { title: "badssl.com's broken-certificate hosts", href: "https://badssl.com/" },
      ]} />

      <style>{`
        .tls-controls { display: flex; flex-wrap: wrap; gap: 12px 20px; }
        .tls-controls > div { display: grid; gap: 4px; }
        .tls-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.6fr); gap: 12px; align-items: start; }
        .tls-panel { border: 1px solid var(--line); background: var(--bg); padding: 8px; display: grid; gap: 8px; min-width: 0; }
        .tls-chain { display: grid; gap: 6px; }
        .tls-cert { border: 1px solid var(--line); border-left: 3px solid var(--accent); padding: 6px 8px; display: grid; gap: 2px; font-size: .82rem; background: var(--surface); }
        .tls-cert b { font-family: var(--f-code); font-size: .78rem; }
        .tls-cert.bad { border-left-color: var(--pain); background: var(--pain-bg); }
        .tls-cert.gone { border-style: dashed; opacity: .7; }
        .tls-cert.evil { border-left-color: var(--pain); }
        .tls-cert .pg-btn { padding: 2px 7px; font-size: .74rem; }
        .tls-break[aria-pressed="true"] { border-color: var(--pain); color: var(--pain); background: var(--pain-bg); }
        .tls-tl { width: 100%; height: auto; display: block; }
        .tls-lane { font-family: var(--f-code); font-size: 10px; text-transform: uppercase; letter-spacing: .04em; fill: var(--ink); }
        .tls-lane.evil { fill: var(--pain); }
        .tls-life { stroke: var(--line); stroke-width: 2; }
        .tls-life.evil { stroke: var(--pain); }
        .tls-rtt { font-family: var(--f-code); font-size: 8.5px; fill: var(--ink-2); }
        .tls-msg line { stroke: var(--ink-2); stroke-width: 1.4; stroke-dasharray: 4 3; }
        .tls-msg.enc line { stroke: var(--accent); stroke-dasharray: none; stroke-width: 1.8; }
        .tls-msg.alert line { stroke: var(--pain); }
        .tls-msg.tcp line { stroke: var(--line); }
        .tls-msg text { font-family: var(--f-code); font-size: 9px; fill: var(--ink); paint-order: stroke; stroke: var(--bg); stroke-width: 3px; }
        .tls-msg.tcp text { fill: var(--ink-2); }
        .tls-msg.alert text { fill: var(--pain); }
        .tls-msg.anim { animation: pg-hop .3s var(--ease) both; }
        .tls-ahead { fill: var(--ink-2); }
        .tls-legend { font-size: .78rem; margin: 0; }
        .tls-checks ol { list-style: none; padding: 0; margin: 4px 0; display: grid; gap: 3px; font-size: .9rem; }
        .tls-mark { display: inline-block; width: 1.4em; font-family: var(--f-code); }
        .tls-checks li.pass { color: var(--good); } .tls-checks li.fail { color: var(--pain); font-weight: 600; }
        .tls-checks li.skipped, .tls-checks li.not-run { color: var(--ink-2); }
        .tls-err { white-space: pre-wrap; word-break: break-word; font-size: .76rem; border: 1px solid var(--pain); background: var(--pain-bg); color: var(--pain); padding: 6px 8px; margin: 6px 0 0; }
        .tls-bad { color: var(--pain); }
        .tls-table { overflow-x: auto; }
        .tls-table table { border-collapse: collapse; width: 100%; font-size: .76rem; font-family: var(--f-code); }
        .tls-table th, .tls-table td { border: 1px solid var(--line); padding: 3px 6px; text-align: left; white-space: nowrap; }
        .tls-table th { font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ink-2); }
        .tls-table tr.mitm td, .tls-table tr.refused td:last-child { color: var(--pain); }
        .tls-goals { list-style: none; padding-left: 0 !important; }
        .tls-goals li.done { color: var(--good); }
        @media (max-width: 720px) { .tls-grid { grid-template-columns: minmax(0, 1fr); } }
        @media (prefers-reduced-motion: reduce) { .tls-msg.anim { animation: none; } }
      `}</style>
    </PgFrame>
  );
}
