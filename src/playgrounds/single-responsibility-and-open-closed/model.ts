// Purpose: after this, the reader can answer: "Which code belongs in the same file?" Code that
// the same team asks to change belongs together; code that different teams change belongs apart,
// even when it looks alike, and new tax rules should arrive as new files, not edits.
//
// The reader arranges InvoiceService's functions into files (click a function, click a file),
// then replays six months of real tickets from three teams against that layout. Two developers
// work in parallel each sprint. The model counts what the layout cost: merge conflicts, other
// teams dragged into reviews, surprise changes to another team's output, and edits to working
// tax code. The one-class layout always runs alongside as the counterfactual.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Actor = "finance" | "brand" | "ops";
export const ACTOR: Record<Actor, string> = { finance: "Finance", brand: "Brand", ops: "Customer Ops" };

export type Unit = "subtotal" | "tax" | "round" | "roundPdf" | "pdf" | "footer" | "send" | "template";
export const UNIT: Record<Unit, { label: string; owner: Actor; note: string }> = {
  subtotal: { label: "subtotal()", owner: "finance", note: "Adds up the invoice lines." },
  tax: { label: "applyTax()", owner: "finance", note: "One branch per country." },
  round: { label: "round2()", owner: "finance", note: "Rounds money to cents. applyTax() calls it, and so does renderPdf()." },
  roundPdf: { label: "round2() for PDF", owner: "brand", note: "Brand's own copy, used only to print amounts." },
  pdf: { label: "renderPdf()", owner: "brand", note: "Logo, layout, line table." },
  footer: { label: "pdfFooter()", owner: "brand", note: "Legal text and bank details." },
  send: { label: "send()", owner: "ops", note: "Delivers the email." },
  template: { label: "emailBody()", owner: "ops", note: "Subject and body text." },
};

export interface Ticket { id: number; sprint: number; actor: Actor; title: string; touches: Unit[]; kind?: "addRule" | "rounding" }
export const TICKETS: Ticket[] = [
  { id: 1, sprint: 1, actor: "finance", title: "Add Spain's 21% IVA", touches: ["tax"], kind: "addRule" },
  { id: 2, sprint: 1, actor: "brand", title: "New logo and brand colours on the PDF", touches: ["pdf"] },
  { id: 3, sprint: 2, actor: "finance", title: "Round VAT half-to-even, as the auditors ask", touches: ["round"], kind: "rounding" },
  { id: 4, sprint: 2, actor: "ops", title: "Send through Amazon SES instead of SMTP", touches: ["send"] },
  { id: 5, sprint: 3, actor: "brand", title: "Two-column layout with a legal footer", touches: ["pdf", "footer"] },
  { id: 6, sprint: 3, actor: "ops", title: "Add Reply-To and an unsubscribe link", touches: ["template", "send"] },
  { id: 7, sprint: 4, actor: "finance", title: "Add Canada: 5% GST plus provincial tax", touches: ["tax"], kind: "addRule" },
  { id: 8, sprint: 4, actor: "finance", title: "Apply volume discounts before tax", touches: ["subtotal", "tax"] },
];
export const SPRINTS = 4;

export type Predict = "finance" | "both" | "none";
export const PREDICT_ANSWER: Predict = "both";

export interface State {
  /** unit -> file number (files are numbered 0..n-1 in order of first use) */
  place: Partial<Record<Unit, number>>;
  /** round2() split into one copy per team that uses it */
  splitRound: boolean;
  /** tax rules as one file per rule, behind a TaxRule interface (open/closed) */
  plugins: boolean;
  selected: Unit | null;
  /** how many times the reader has replayed the tickets; results show from the first replay on */
  replays: number;
  predict: Predict | null;
}

export type Action =
  | { type: "select"; unit: Unit }
  | { type: "move"; file: number | "new" }
  | { type: "preset"; preset: Preset }
  | { type: "splitRound"; on: boolean }
  | { type: "plugins"; on: boolean }
  | { type: "replay" }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export type Preset = "oneClass" | "byTeam" | "perFunction";

export const unitsOf = (s: Pick<State, "splitRound">): Unit[] =>
  (["subtotal", "tax", "round", "pdf", "footer", "roundPdf", "send", "template"] as Unit[]).filter((u) => u !== "roundPdf" || s.splitRound);

/** Who has to care about a unit: its owner, plus Brand for the shared round2(). */
export function ownersOf(s: Pick<State, "splitRound">, u: Unit): Actor[] {
  if (u === "round" && !s.splitRound) return ["finance", "brand"];
  return [UNIT[u].owner];
}

/** Renumber files 0..n-1 in a stable order, dropping empty ones. */
function normalise(s: State): State {
  const map = new Map<number, number>();
  const place: Partial<Record<Unit, number>> = {};
  for (const u of unitsOf(s)) {
    const f = s.place[u] ?? 0;
    if (!map.has(f)) map.set(f, map.size);
    place[u] = map.get(f)!;
  }
  return { ...s, place };
}

export function files(s: State): Unit[][] {
  const out: Unit[][] = [];
  for (const u of unitsOf(s)) (out[s.place[u] ?? 0] ??= []).push(u);
  return out;
}

function presetPlace(p: Preset): Partial<Record<Unit, number>> {
  if (p === "oneClass") return { subtotal: 0, tax: 0, round: 0, roundPdf: 0, pdf: 0, footer: 0, send: 0, template: 0 };
  if (p === "byTeam") return { subtotal: 0, tax: 0, round: 0, pdf: 1, footer: 1, roundPdf: 1, send: 2, template: 2 };
  return { subtotal: 0, tax: 1, round: 2, pdf: 3, footer: 4, roundPdf: 5, send: 6, template: 7 };
}

export function init(): State {
  return { place: presetPlace("oneClass"), splitRound: false, plugins: false, selected: null, replays: 0, predict: null };
}

/* ---------------- the replay ---------------- */

export interface TicketResult {
  ticket: Ticket;
  /** files edited; -1 stands for a brand-new file */
  files: number[];
  /** other teams whose code sits in the edited files, so they must review and retest */
  pulled: Actor[];
  conflict: boolean;
  /** another team's output changed although they asked for nothing */
  surprise: Actor | null;
  /** an addRule ticket that edited the existing tax code */
  taxEdit: boolean;
}

export interface Tally {
  conflicts: number;
  pulled: number;
  surprises: number;
  taxEdits: number;
  newFiles: number;
  /** tickets that had to edit more than one existing file */
  scattered: number;
  fileCount: number;
}

export interface Replay { results: TicketResult[]; tally: Tally }

export function replay(s: State): Replay {
  const fs = files(s);
  const touched = (t: Ticket): number[] =>
    t.kind === "addRule" && s.plugins ? [-1] : [...new Set(t.touches.map((u) => s.place[u] ?? 0))];
  const results: TicketResult[] = TICKETS.map((t) => {
    const f = touched(t);
    const pulled = new Set<Actor>();
    for (const i of f) if (i >= 0) for (const u of fs[i] ?? []) for (const a of ownersOf(s, u)) if (a !== t.actor) pulled.add(a);
    return {
      ticket: t,
      files: f,
      pulled: [...pulled],
      conflict: false,
      surprise: t.kind === "rounding" && !s.splitRound ? "brand" : null,
      taxEdit: t.kind === "addRule" && !s.plugins,
    };
  });
  // Two developers per sprint: a conflict when both tickets edit the same existing file.
  for (let sp = 1; sp <= SPRINTS; sp++) {
    const pair = results.filter((r) => r.ticket.sprint === sp);
    if (pair.length === 2 && pair[0].files.some((f) => f >= 0 && pair[1].files.includes(f))) pair[1].conflict = true;
  }
  const tally: Tally = {
    conflicts: results.filter((r) => r.conflict).length,
    pulled: results.reduce((n, r) => n + r.pulled.length, 0),
    surprises: results.filter((r) => r.surprise).length,
    taxEdits: results.filter((r) => r.taxEdit).length,
    newFiles: results.filter((r) => r.files.includes(-1)).length,
    scattered: results.filter((r) => r.files.filter((f) => f >= 0).length > 1).length,
    fileCount: fs.length,
  };
  return { results, tally };
}

/** The counterfactual: the same tickets against the original one-class InvoiceService. */
export const baseline = (): Replay => replay(init());

/* ---------------- step ---------------- */

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "select":
      return { ...s, selected: s.selected === a.unit ? null : a.unit };
    case "move": {
      if (!s.selected) return s;
      const target = a.file === "new" ? files(s).length : a.file;
      return normalise({ ...s, place: { ...s.place, [s.selected]: target }, selected: null });
    }
    case "preset":
      return normalise({ ...s, place: presetPlace(a.preset), selected: null });
    case "splitRound": {
      if (a.on === s.splitRound) return s;
      // Brand's copy starts next to renderPdf(), which is the code that calls it.
      const place = a.on ? { ...s.place, roundPdf: s.place.pdf ?? 0 } : s.place;
      return normalise({ ...s, splitRound: a.on, place, selected: s.selected === "roundPdf" ? null : s.selected });
    }
    case "plugins":
      return { ...s, plugins: a.on };
    case "replay":
      return { ...s, replays: s.replays + 1, selected: null };
    case "predict":
      return s.replays > 0 ? s : { ...s, predict: a.value };
  }
}
