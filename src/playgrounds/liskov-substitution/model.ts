// Purpose: after this, the reader can answer: "Why can a type that compiles against an interface
// still break the code that uses it, and what does it have to promise to be substitutable?"
//
// A substitution matrix. Rows are storage backends that all implement BlobStore; columns are
// real callers (the programs P in Liskov's definition). The reader plugs each backend in where
// S3 was and runs every caller against it. Every backend type-checks; some still break callers,
// each by breaking a different clause of the contract (a new exception, a weaker postcondition,
// a stronger precondition). Then the reader tries fixes: callers that check the type, a weaker
// contract, splitting the interface, or fixing the backend itself, and sees which ones remove
// failures without spreading knowledge of one backend into every caller.
//
// Plain state + a pure step function, so it can be tested without a browser.

export type Backend = "s3" | "archive" | "replica" | "nfs";
export type Caller = "upload" | "thumbs" | "report" | "retention";
export const BACKENDS: Backend[] = ["s3", "archive", "replica", "nfs"];
export const CALLERS: Caller[] = ["upload", "thumbs", "report", "retention"];

export const BACKEND: Record<Backend, { name: string; what: string }> = {
  s3: { name: "S3Store", what: "The original. Every caller was written and tested against it." },
  archive: { name: "ArchiveStore", what: "Cold storage for finished years. Read-only: writes are switched off." },
  replica: { name: "ReplicaStore", what: "Writes go to the primary; reads come from a nearby replica that lags about a second." },
  nfs: { name: "NfsStore", what: "An on-prem file share. Paths longer than 64 characters are rejected." },
};
export const CALLER: Record<Caller, { name: string; what: string }> = {
  upload: { name: "Upload API", what: "Stores a user's file." },
  thumbs: { name: "Thumbnailer", what: "Reads an image, writes a thumbnail, reads it back to serve it." },
  report: { name: "Monthly report", what: "Lists last month's reports and reads them." },
  retention: { name: "Retention job", what: "Deletes temp files older than 30 days." },
};

/** The contract every caller relies on. Each clause is one of Liskov and Wing's rules. */
export type Clause = "errors" | "readAfterWrite" | "keys" | "delete";
export const CLAUSE: Record<Clause, { text: string; rule: string }> = {
  keys: { text: "Accepts any key up to 1024 bytes.", rule: "Preconditions cannot be strengthened" },
  readAfterWrite: { text: "After put(k, b) returns, get(k) returns b.", rule: "Postconditions cannot be weakened" },
  delete: { text: "After delete(k) returns, get(k) is NotFound.", rule: "Postconditions cannot be weakened" },
  errors: { text: "Fails only with NotFound or Unavailable.", rule: "No new exceptions" },
};

export type ArchiveFix = "none" | "typeCheck" | "widen" | "split";
export const ARCHIVE_FIX: Record<ArchiveFix, { label: string; what: string }> = {
  none: { label: "No fix", what: "ArchiveStore implements put and delete by throwing ReadOnlyError." },
  typeCheck: { label: "Callers check the type", what: "Each caller that writes adds `if store is ArchiveStore` and skips the write." },
  widen: { label: "Weaken the contract", what: "BlobStore now says any write may throw ReadOnlyError. Every caller that writes catches it." },
  split: { label: "Split the interface", what: "BlobReader has get and list; BlobStore extends it with put and delete. ArchiveStore implements only BlobReader." },
};

export const KEY_UPLOAD = "uploads/acme/9f2c41d0-6b1e-4c55-a0d7-2f9c3e1b7a44.jpg";
export const KEY_THUMB = "thumbs/w320/" + KEY_UPLOAD;
export const NFS_LIMIT = 64;

export type Status = "pass" | "fail" | "handled" | "rejected";
export interface Step { call: string; result: string; ok: boolean }
export interface Run { backend: Backend; caller: Caller; status: Status; steps: Step[]; broke: Clause | null; explain: string }

export type Predict = "none" | "writers" | "all";
export const PREDICT_ANSWER: Predict = "writers";

export interface State {
  revealed: Backend[];
  selected: { backend: Backend; caller: Caller } | null;
  archiveFix: ArchiveFix;
  replicaFixed: boolean;
  nfsFixed: boolean;
  predict: Predict | null;
  /** the reader has opened the trace of the silent failure (replica + thumbnailer) */
  foundSilent: boolean;
}

export type Action =
  | { type: "plug"; backend: Backend }
  | { type: "inspect"; backend: Backend; caller: Caller }
  | { type: "archiveFix"; fix: ArchiveFix }
  | { type: "fixReplica"; on: boolean }
  | { type: "fixNfs"; on: boolean }
  | { type: "predict"; value: Predict }
  | { type: "reset" };

export function init(): State {
  return { revealed: ["s3"], selected: null, archiveFix: "none", replicaFixed: false, nfsFixed: false, predict: null, foundSilent: false };
}

/* ---------------- running one caller against one backend ---------------- */

const writes = (c: Caller) => c !== "report";

export function run(s: Pick<State, "archiveFix" | "replicaFixed" | "nfsFixed">, backend: Backend, caller: Caller): Run {
  const steps: Step[] = [];
  const ok = (call: string, result: string) => steps.push({ call, result, ok: true });
  const bad = (call: string, result: string) => steps.push({ call, result, ok: false });
  const done = (status: Status, broke: Clause | null, explain: string): Run => ({ backend, caller, status, steps, broke, explain });

  // Split interface: the archive is only a BlobReader, so it cannot be passed to a caller that needs writes.
  if (backend === "archive" && s.archiveFix === "split" && writes(caller)) {
    bad(`new ${CALLER[caller].name.replace(/ /g, "")}(archive)`, "type error: ArchiveStore is not a BlobStore");
    return done("rejected", null, "The compiler refuses to plug a read-only store into a caller that writes. The mistake never reaches production.");
  }
  const archiveWrite = (call: string): Run | null => {
    if (backend !== "archive") return null;
    if (s.archiveFix === "typeCheck") {
      ok("store is ArchiveStore?", "yes, skip the write");
      return done("handled", null, `No crash, but ${CALLER[caller].name} now names ArchiveStore, and quietly does nothing. The next read-only backend needs the same if.`);
    }
    if (s.archiveFix === "widen") {
      bad(call, "ReadOnlyError, caught");
      return done("handled", null, `${CALLER[caller].name} catches ReadOnlyError and gives up. The contract now promises less for every backend, including S3, and the feature still does not work.`);
    }
    bad(call, "ReadOnlyError");
    return done("fail", "errors", `ArchiveStore throws an error the contract never mentioned. ${CALLER[caller].name} was not written to expect it, so it fails in production.`);
  };
  const tooLong = (key: string) => backend === "nfs" && !s.nfsFixed && key.length > NFS_LIMIT;
  const keyArg = (key: string) => (key.length > 26 ? key.slice(0, 22) + "…" : key);

  switch (caller) {
    case "upload": {
      const call = `put(${keyArg(KEY_UPLOAD)}, 182 KB)`;
      const a = archiveWrite(call); if (a) return a;
      ok(call, "stored");
      return done("pass", null, "The upload is stored and the API returns its URL.");
    }
    case "thumbs": {
      ok(`get(${keyArg(KEY_UPLOAD)})`, "182 KB");
      const call = `put(${keyArg(KEY_THUMB)}, 14 KB)`;
      const a = archiveWrite(call); if (a) return a;
      if (tooLong(KEY_THUMB)) {
        bad(call, `InvalidKey: ${KEY_THUMB.length} > ${NFS_LIMIT} chars`);
        return done("fail", "keys", `NfsStore demands shorter keys than the contract allows. The upload key fitted (${KEY_UPLOAD.length} chars), so every test with short keys passed; the thumbnail key is ${KEY_THUMB.length}.`);
      }
      ok(call, backend === "nfs" ? "stored under a hashed path" : "stored");
      if (backend === "replica" && !s.replicaFixed) {
        bad(`get(${keyArg(KEY_THUMB)})`, "NotFound");
        return done("fail", "readAfterWrite", "No exception, nothing unusual in the types. The read went to a replica that had not caught up, so the thumbnail the Thumbnailer just wrote was not there. The promise after put was quietly weaker.");
      }
      ok(`get(${keyArg(KEY_THUMB)})`, "14 KB");
      return done("pass", null, backend === "replica" ? "Reads of your own fresh writes go to the primary, so the thumbnail is there." : "The thumbnail is written and served.");
    }
    case "report": {
      ok("list(reports/2025-10/)", "2 keys");
      ok("get(reports/2025-10/eu.csv)", "48 KB");
      ok("get(reports/2025-10/us.csv)", "51 KB");
      return done("pass", null, backend === "archive" ? "The report only reads, and reading is something the archive does fully. Here it is a perfect substitute." : "The report reads old files that every backend has.");
    }
    case "retention": {
      ok("list(tmp/)", "3 keys older than 30 days");
      const call = "delete(tmp/export-0912.zip)";
      const a = archiveWrite(call); if (a) return a;
      ok(call, "deleted");
      ok("delete(tmp/export-0913.zip)", "deleted");
      ok("delete(tmp/export-0914.zip)", "deleted");
      return done("pass", null, "Old temp files are gone.");
    }
  }
}

export function matrix(s: State): Run[] {
  return BACKENDS.flatMap((b) => CALLERS.map((c) => run(s, b, c)));
}

/* ---------------- what the reader's design cost ---------------- */

export interface Tally {
  /** caller/backend pairs that break in production */
  failures: number;
  /** pairs that run without a crash but silently do nothing useful */
  handled: number;
  /** pairs the compiler refuses */
  rejected: number;
  /** callers whose source names a concrete backend */
  namesConcrete: number;
  /** callers edited for the fixes */
  callersEdited: number;
  /** backends edited for the fixes */
  backendsEdited: number;
}

export function tally(s: State): Tally {
  const m = matrix(s);
  const writers = CALLERS.filter(writes).length;
  return {
    failures: m.filter((r) => r.status === "fail").length,
    handled: m.filter((r) => r.status === "handled").length,
    rejected: m.filter((r) => r.status === "rejected").length,
    namesConcrete: s.archiveFix === "typeCheck" ? writers : 0,
    // split: only the report's parameter type narrows to BlobReader
    callersEdited: s.archiveFix === "typeCheck" || s.archiveFix === "widen" ? writers : s.archiveFix === "split" ? 1 : 0,
    backendsEdited: (s.archiveFix === "split" ? 1 : 0) + (s.replicaFixed ? 1 : 0) + (s.nfsFixed ? 1 : 0),
  };
}

/** Guided challenges, checked against the state. */
export function challenges(s: State) {
  const t = tally(s);
  return [
    { id: "archive", text: "Plug in ArchiveStore and see which callers break.", done: s.revealed.includes("archive") },
    { id: "silent", text: "Find the backend that throws nothing and still breaks a caller. Open its trace.", done: s.foundSilent },
    { id: "zero", text: "Get every pair to work or be refused by the compiler, with no caller naming a backend.", done: s.revealed.length === BACKENDS.length && t.failures === 0 && t.handled === 0 && t.namesConcrete === 0 },
  ];
}

/* ---------------- step ---------------- */

export function step(s: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "plug":
      return s.revealed.includes(a.backend) ? s : { ...s, revealed: [...s.revealed, a.backend] };
    case "inspect":
      if (!s.revealed.includes(a.backend)) return step(step(s, { type: "plug", backend: a.backend }), a);
      return {
        ...s,
        selected: { backend: a.backend, caller: a.caller },
        foundSilent: s.foundSilent || (a.backend === "replica" && a.caller === "thumbs" && !s.replicaFixed),
      };
    case "archiveFix":
      return { ...s, archiveFix: a.fix };
    case "fixReplica":
      return { ...s, replicaFixed: a.on };
    case "fixNfs":
      return { ...s, nfsFixed: a.on };
    case "predict":
      return s.revealed.includes("archive") ? s : { ...s, predict: a.value };
  }
}
