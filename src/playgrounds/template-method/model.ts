// Template Method playground: five months of tickets against three bank-data importers, kept in
// two codebases side by side. In one, each importer is a full copy of the pipeline. In the other,
// a base Importer owns the order of steps (open, parse, validate, transform, load) and each
// importer only writes parse.
//
// After this, the reader can answer: why does a fix made where the bug was reported reach every
// importer in the template design and only one in the copied design, and what does the template
// cost when one importer needs something the others do not?
//
// Tickets, one per month:
// 0. Duplicates in the ledger (reported against CSV). Fix: dedupe in validate.
// 1. Amounts lose cents (reported against JSON). Fix: integer cents in transform.
// 2. A dropped connection left a half-loaded file (reported against Bank). Fix: one DB transaction in load.
// 3. Bank statements must check the opening balance before loading. Only Bank needs it.
//    Copied: one edit in Bank's copy. Template: a hook call in the base plus an override in Bank.
//    Break it: override in Bank without the hook call, and the check never runs.
// 4. A new Stripe payouts importer. Copied: copy an existing importer, and inherit its drift.
//    Template: write parse only.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Design = "copied" | "template";
export type Imp = "csv" | "json" | "bank" | "stripe";
export type Fix = "dedupe" | "cents" | "atomic";
export type StepId = "validate" | "transform" | "load";

export const DESIGNS: Design[] = ["copied", "template"];
export const NAME: Record<Imp, string> = { csv: "CSV", json: "JSON", bank: "Bank statement", stripe: "Stripe payouts" };
export const FIX_STEP: Record<Fix, StepId> = { dedupe: "validate", cents: "transform", atomic: "load" };
export const FIX_LABEL: Record<Fix, string> = { dedupe: "dedupe", cents: "cents", atomic: "one tx" };
export const STEPS: StepId[] = ["validate", "transform", "load"];

export interface Ticket {
  kind: "fix" | "hook" | "new";
  fix?: Fix;
  /** The importer the bug report names. */
  reported?: Imp;
  title: string;
  why: string;
}

export const TICKETS: Ticket[] = [
  { kind: "fix", fix: "dedupe", reported: "csv", title: "Duplicate transactions in the ledger",
    why: "Finance found the same CSV transaction posted twice. Skip rows whose transaction id was already loaded. Every partner file can contain repeats." },
  { kind: "fix", fix: "cents", reported: "json", title: "Amounts are off by a cent",
    why: "A JSON import stored 19.99 as a float and the ledger is off by a cent. Convert amounts to integer cents in transform." },
  { kind: "fix", fix: "atomic", reported: "bank", title: "A half-loaded statement",
    why: "The database connection dropped halfway through a bank statement and half of it stayed in the ledger. Load each file in one database transaction." },
  { kind: "hook", reported: "bank", title: "Check the opening balance",
    why: "A bank statement with a missing day slipped in. Before loading a statement, check its opening balance against last month's closing balance. Only bank statements have balances." },
  { kind: "new", title: "Import Stripe payouts",
    why: "Stripe payouts arrive as a new file type next month. Add an importer for them." },
];

export interface CopyImp { fixes: Fix[]; balanceCheck: boolean }
export interface Tally { edits: number; places: string[] }

export interface CopiedState { imps: Partial<Record<Imp, CopyImp>>; tally: Tally }
export interface TemplateState {
  /** Fixes in the base Importer's shared steps. */
  fixes: Fix[];
  /** The base run() calls a before_load hook (empty by default). */
  hook: boolean;
  /** Bank overrides before_load with the balance check. */
  bankOverride: boolean;
  imps: Imp[];
  tally: Tally;
}

export interface Problem { imp: Imp; text: string }
export interface Outcome { edits: number; places: string[]; problems: Problem[] }
export interface MonthResult { ticket: number; copied: Outcome; template: Outcome }

export interface State {
  ticket: number; // 0..4, 5 = finished
  phase: "work" | "ran";
  copied: CopiedState;
  template: TemplateState;
  /** Edits made before the current ticket, per design. */
  startEdits: Record<Design, number>;
  results: MonthResult[];
  predictions: Record<number, string | null>;
}

export type Action =
  | { type: "patch"; design: Design; imp?: Imp }   // apply the current ticket's fix to one copy (copied) or the base (template)
  | { type: "addCheck" }                           // copied: balance check in Bank's copy
  | { type: "addHook" }                            // template: base run() calls before_load
  | { type: "overrideBank" }                       // template: Bank overrides before_load
  | { type: "copyFrom"; src: Imp }                 // copied: Stripe importer as a copy of src
  | { type: "writeParse" }                         // template: Stripe importer writes parse only
  | { type: "run" }                                // ship both codebases and run month-end import
  | { type: "next" }
  | { type: "predict"; ticket: number; value: string }
  | { type: "reset" };

export function init(): State {
  const imp = (): CopyImp => ({ fixes: [], balanceCheck: false });
  return {
    ticket: 0,
    phase: "work",
    copied: { imps: { csv: imp(), json: imp(), bank: imp() }, tally: { edits: 0, places: [] } },
    template: { fixes: [], hook: false, bankOverride: false, imps: ["csv", "json", "bank"], tally: { edits: 0, places: [] } },
    startEdits: { copied: 0, template: 0 },
    results: [],
    predictions: {},
  };
}

const edit = (t: Tally, place: string): Tally => ({ edits: t.edits + 1, places: [...t.places, place] });

/** Fixes whose bug is present in the data by month `ticket` (every earlier fix ticket and this one). */
export function activeFixes(ticket: number): Fix[] {
  return TICKETS.slice(0, ticket + 1).flatMap((t) => (t.fix ? [t.fix] : []));
}

/** Files that arrive at month-end: Stripe payouts only from the Stripe ticket on. */
export function files(ticket: number): Imp[] {
  return ticket >= 4 ? ["csv", "json", "bank", "stripe"] : ["csv", "json", "bank"];
}

const PROBLEM: Record<Fix, string> = {
  dedupe: "posted duplicate transactions",
  cents: "lost cents on float amounts",
  atomic: "left a half-loaded file after a dropped connection",
};

/** Which fixes an importer actually runs with, in each design. */
export function fixesOf(st: State, d: Design, imp: Imp): Fix[] | null {
  if (d === "copied") return st.copied.imps[imp]?.fixes ?? null;
  return st.template.imps.includes(imp) ? st.template.fixes : null;
}

/** Month-end import: what went wrong in one design, given the data problems present by `ticket`. */
export function evaluate(st: State, d: Design, ticket: number): Problem[] {
  const out: Problem[] = [];
  for (const imp of files(ticket)) {
    const fx = fixesOf(st, d, imp);
    if (!fx) { out.push({ imp, text: "has no importer, so the payouts were never posted" }); continue; }
    for (const f of activeFixes(ticket)) if (!fx.includes(f)) out.push({ imp, text: PROBLEM[f] });
    if (ticket >= 3 && imp === "bank") {
      const works = d === "copied" ? !!st.copied.imps.bank?.balanceCheck : st.template.hook && st.template.bankOverride;
      if (!works) {
        const never = d === "template" && st.template.bankOverride && !st.template.hook;
        out.push({ imp, text: never ? "loaded a statement with a missing day: the override exists, but run() never calls it" : "loaded a statement with a missing day" });
      }
    }
    if (imp === "stripe" && d === "copied" && st.copied.imps.stripe?.balanceCheck)
      out.push({ imp, text: "rejected every payout: the copied balance check expects an opening balance" });
  }
  return out;
}

/** Copies whose shared steps disagree with each other: one per (fix, importer) that is missing it. */
export function drift(st: State): number {
  const imps = Object.values(st.copied.imps) as CopyImp[];
  const all = new Set(imps.flatMap((i) => i.fixes));
  return imps.reduce((n, i) => n + [...all].filter((f) => !i.fixes.includes(f)).length, 0);
}

export function ticketEdits(st: State, d: Design): number {
  return st[d].tally.edits - st.startEdits[d];
}

export function step(st: State, a: Action): State {
  const t = TICKETS[st.ticket];
  const working = st.phase === "work" && !!t;
  switch (a.type) {
    case "reset":
      return init();

    case "predict":
      if (st.predictions[a.ticket] && st.phase === "ran") return st;
      return { ...st, predictions: { ...st.predictions, [a.ticket]: a.value } };

    case "patch": {
      if (!working || t.kind !== "fix" || !t.fix) return st;
      const fix = t.fix;
      if (a.design === "copied") {
        const imp = a.imp ? st.copied.imps[a.imp] : undefined;
        if (!a.imp || !imp || imp.fixes.includes(fix)) return st;
        const imps = { ...st.copied.imps, [a.imp]: { ...imp, fixes: [...imp.fixes, fix] } };
        return { ...st, copied: { imps, tally: edit(st.copied.tally, `${a.imp} ${FIX_STEP[fix]}`) } };
      }
      if (st.template.fixes.includes(fix)) return st;
      return { ...st, template: { ...st.template, fixes: [...st.template.fixes, fix], tally: edit(st.template.tally, `base ${FIX_STEP[fix]}`) } };
    }

    case "addCheck": {
      const bank = st.copied.imps.bank;
      if (!working || t.kind !== "hook" || !bank || bank.balanceCheck) return st;
      return { ...st, copied: { imps: { ...st.copied.imps, bank: { ...bank, balanceCheck: true } }, tally: edit(st.copied.tally, "bank load") } };
    }

    case "addHook":
      if (!working || t.kind !== "hook" || st.template.hook) return st;
      return { ...st, template: { ...st.template, hook: true, tally: edit(st.template.tally, "base run") } };

    case "overrideBank":
      if (!working || t.kind !== "hook" || st.template.bankOverride) return st;
      return { ...st, template: { ...st.template, bankOverride: true, tally: edit(st.template.tally, "bank before_load") } };

    case "copyFrom": {
      const src = st.copied.imps[a.src];
      if (!working || t.kind !== "new" || !src || a.src === "stripe" || st.copied.imps.stripe) return st;
      const stripe: CopyImp = { fixes: [...src.fixes], balanceCheck: src.balanceCheck };
      return { ...st, copied: { imps: { ...st.copied.imps, stripe }, tally: edit(st.copied.tally, `stripe (copy of ${a.src})`) } };
    }

    case "writeParse":
      if (!working || t.kind !== "new" || st.template.imps.includes("stripe")) return st;
      return { ...st, template: { ...st.template, imps: [...st.template.imps, "stripe"], tally: edit(st.template.tally, "stripe parse") } };

    case "run": {
      if (!working) return st;
      const outcome = (d: Design): Outcome => ({
        edits: ticketEdits(st, d),
        places: st[d].tally.places.slice(st.startEdits[d]),
        problems: evaluate(st, d, st.ticket),
      });
      return { ...st, phase: "ran", results: [...st.results, { ticket: st.ticket, copied: outcome("copied"), template: outcome("template") }] };
    }

    case "next":
      if (st.phase !== "ran" || st.ticket >= TICKETS.length) return st;
      return { ...st, ticket: st.ticket + 1, phase: "work", startEdits: { copied: st.copied.tally.edits, template: st.template.tally.edits } };
  }
}

/** Totals over all months run so far. */
export function totals(st: State) {
  const sum = (d: Design) => st.results.reduce((acc, r) => ({ edits: acc.edits + r[d].edits, problems: acc.problems + r[d].problems.length }), { edits: 0, problems: 0 });
  return { copied: sum("copied"), template: sum("template") };
}
