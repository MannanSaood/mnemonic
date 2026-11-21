// Syscall path playground: replay a write-ahead log at startup, one record at a time.
//
// After this, the reader can answer: why does reading a file 4 and 96 bytes at a time cost
// about ten times more than reading the same bytes through a 64 KiB buffer, even when the whole
// file is already in RAM? (Because the cost is paid per crossing into the kernel, not per byte.)
//
// The view draws one read() as a path through layers: your code, the user-space buffer, the
// libc or runtime wrapper, the `syscall` instruction, the kernel entry, the dispatch, vfs_read,
// the page cache and the checked copy back. The reader steps single reads (and watches some of
// them never leave user space once a buffer is in place), then replays the whole log and
// compares syscalls, mode switches and time. Break-it toggles: attach strace (a ptrace stop on
// every entry and exit) and run on a CPU that needs the Meltdown page-table switch.
//
// Costs are a model with realistic orders of magnitude for a modern x86-64 server, not a
// benchmark: a syscall round trip of about 0.1 µs plus the kernel's own read work, copies at
// about 10 GB/s, a few nanoseconds for a call into a user-space buffer.
//
// Plain state + a pure step function, so it can be tested without a browser.

export const RECORDS = 1_000_000;
export const HEADER = 4;
export const BODY = 96;
export const FILE_BYTES = RECORDS * (HEADER + BODY); // 100 MB

export type BufSize = 0 | 4096 | 65536 | 1048576;
export const BUF_SIZES: BufSize[] = [0, 4096, 65536, 1048576];

/** Model costs in nanoseconds. */
export const COST = {
  /** syscall instruction, entry, register save, dispatch, sysret: the crossing itself. */
  crossing: 70,
  /** Extra per crossing when the kernel must switch page tables (KPTI on CPUs hit by Meltdown). */
  kpti: 180,
  /** fd lookup, vfs_read, page-cache lookup: the kernel's own work per read. */
  kernelRead: 150,
  /** strace: a ptrace stop at entry and at exit, each a round trip to the tracer process. */
  strace: 25_000,
  /** A call into a user-space buffered reader (bounds checks, bookkeeping). */
  userCall: 6,
  /** Copying, per byte (about 10 GB/s). */
  copyPerByte: 0.1,
} as const;

export type Layer = "user" | "edge" | "kernel";
export interface Hop { id: string; layer: Layer; label: string; note: string }

export interface ReplayResult {
  buffer: BufSize;
  kpti: boolean;
  strace: boolean;
  syscalls: number;
  modeSwitches: number;
  /** Total time in ms. */
  ms: number;
  /** Of which, ms spent crossing into and out of the kernel (crossing, KPTI, strace). */
  crossingMs: number;
}

export interface State {
  buffer: BufSize;
  kpti: boolean;
  strace: boolean;
  /** Stepping: which application read comes next (even = 4-byte header, odd = body). */
  appReads: number;
  /** Bytes left in the user-space buffer while stepping. */
  buffered: number;
  /** Syscalls made while stepping. */
  stepSyscalls: number;
  /** The path of the last traced call, for the view to animate. */
  trace: { kind: "read" | "vdso"; want: number; syscall: boolean; count: number; hops: Hop[]; ns: number } | null;
  traceId: number;
  prediction: "same" | "2x" | "10x" | null;
  last: ReplayResult | null;
  /** One run per configuration, newest last. */
  runs: ReplayResult[];
}

export type Action =
  | { type: "buffer"; size: BufSize }
  | { type: "kpti" }
  | { type: "strace" }
  | { type: "step" }
  | { type: "vdso" }
  | { type: "replay" }
  | { type: "predict"; value: "same" | "2x" | "10x" }
  | { type: "reset" };

export function init(): State {
  return {
    buffer: 0, kpti: false, strace: false,
    appReads: 0, buffered: 0, stepSyscalls: 0,
    trace: null, traceId: 0,
    prediction: null, last: null, runs: [],
  };
}

/** Cost of one crossing (enter and leave the kernel) under the current switches. */
export function crossingNs(kpti: boolean, strace: boolean): number {
  return COST.crossing + (kpti ? COST.kpti : 0) + (strace ? COST.strace : 0);
}

/** Number of read(2) calls to replay the whole log with a given buffer (including the final read that returns 0). */
export function syscallsFor(buffer: BufSize): number {
  if (buffer === 0) return RECORDS * 2 + 1;
  return Math.ceil(FILE_BYTES / buffer) + 1;
}

/** Replay the whole log: count syscalls and add up the model costs. */
export function replay(buffer: BufSize, kpti: boolean, strace: boolean): ReplayResult {
  const syscalls = syscallsFor(buffer);
  const crossing = syscalls * crossingNs(kpti, strace);
  const kernel = syscalls * COST.kernelRead + FILE_BYTES * COST.copyPerByte; // kernel copies every byte once
  const user = buffer === 0 ? 0 : RECORDS * 2 * COST.userCall + FILE_BYTES * COST.copyPerByte; // buffer to record: a second copy
  const ns = crossing + kernel + user;
  return { buffer, kpti, strace, syscalls, modeSwitches: syscalls * 2, ms: ns / 1e6, crossingMs: crossing / 1e6 };
}

/** The layers one syscall-making read() passes through, in order, down and back up. */
export function syscallHops(count: number, kpti: boolean, strace: boolean): Hop[] {
  const hops: Hop[] = [
    { id: "wrapper", layer: "user", label: "wrapper", note: `libc read() or the runtime puts 0 (read) in rax, the fd in rdi, the buffer address in rsi and ${count} in rdx.` },
    { id: "syscall", layer: "edge", label: "syscall", note: "The CPU switches to kernel mode and jumps to the entry address the kernel stored in a model-specific register." },
    { id: "entry", layer: "kernel", label: "entry_SYSCALL_64", note: kpti ? "Saves your registers on this task's kernel stack and switches to the kernel's page tables (KPTI)." : "Saves your registers on this task's kernel stack." },
  ];
  if (strace) hops.push({ id: "ptrace", layer: "kernel", label: "ptrace stop", note: "strace is attached: the task stops, the tracer process is woken and reads the arguments, then lets it go on." });
  hops.push(
    { id: "dispatch", layer: "kernel", label: "x64_sys_call", note: "Dispatch on the number in rax: 0 is read, so sys_read runs." },
    { id: "vfs", layer: "kernel", label: "ksys_read → vfs_read", note: "Looks up fd 3 in the task's file table, checks the file is open for reading, calls the file system's read." },
    { id: "cache", layer: "kernel", label: "page cache", note: "The pages are already in RAM. No disk I/O." },
    { id: "copy", layer: "kernel", label: "copy to user", note: `Copies ${count} bytes into your buffer, checking that the address really is yours.` },
    { id: "sysret", layer: "edge", label: "sysret", note: `Back to user mode with rax = ${count}, the number of bytes read.` },
  );
  return hops;
}

export function step(st: State, a: Action): State {
  switch (a.type) {
    case "reset":
      return init();
    case "buffer":
      // A new buffer size starts stepping over; earlier replays stay for comparison.
      return { ...st, buffer: a.size, appReads: 0, buffered: 0, stepSyscalls: 0, trace: null };
    case "kpti":
      return { ...st, kpti: !st.kpti, trace: null };
    case "strace":
      return { ...st, strace: !st.strace, trace: null };
    case "predict":
      return st.prediction ? st : { ...st, prediction: a.value };
    case "vdso": {
      const hops: Hop[] = [
        { id: "app", layer: "user", label: "your code", note: "Asks for the time: clock_gettime(CLOCK_MONOTONIC)." },
        { id: "vdso", layer: "user", label: "vDSO", note: "A small library the kernel maps into every process. It reads clock data the kernel keeps up to date in a shared page." },
        { id: "done", layer: "user", label: "return", note: "No syscall instruction, no mode switch, nothing for strace to see." },
      ];
      return { ...st, trace: { kind: "vdso", want: 0, syscall: false, count: 0, hops, ns: 20 }, traceId: st.traceId + 1 };
    }
    case "step": {
      const want = st.appReads % 2 === 0 ? HEADER : BODY;
      const app: Hop = { id: "app", layer: "user", label: "your code", note: `Asks for the next ${want === HEADER ? "4-byte header" : "96-byte body"}.` };
      const cross = crossingNs(st.kpti, st.strace);
      if (st.buffer === 0) {
        const hops = [app, ...syscallHops(want, st.kpti, st.strace), { id: "back", layer: "user" as Layer, label: "your code", note: `Has ${want} bytes. One syscall for ${want} bytes.` }];
        const ns = cross + COST.kernelRead + want * COST.copyPerByte;
        return { ...st, appReads: st.appReads + 1, stepSyscalls: st.stepSyscalls + 1, trace: { kind: "read", want, syscall: true, count: want, hops, ns }, traceId: st.traceId + 1 };
      }
      if (st.buffered >= want) {
        const hops: Hop[] = [
          app,
          { id: "buf", layer: "user", label: "buffer hit", note: `${want} bytes copied out of the ${st.buffer / 1024} KiB buffer. ${st.buffered - want} bytes still buffered.` },
          { id: "back", layer: "user", label: "your code", note: "Has its bytes. The kernel never ran." },
        ];
        const ns = COST.userCall + want * COST.copyPerByte;
        return { ...st, appReads: st.appReads + 1, buffered: st.buffered - want, trace: { kind: "read", want, syscall: false, count: 0, hops, ns }, traceId: st.traceId + 1 };
      }
      // Buffer empty (records are laid out so a refill always leaves enough): one big read.
      const count = st.buffer;
      const hops: Hop[] = [
        app,
        { id: "buf", layer: "user", label: "buffer empty", note: `The buffer has ${st.buffered} bytes, so it refills with one read of ${count / 1024} KiB.` },
        ...syscallHops(count, st.kpti, st.strace),
        { id: "back", layer: "user", label: "your code", note: `Gets its ${want} bytes. The next ${Math.floor((count - want) / ((HEADER + BODY) / 2))} reads or so come from the buffer.` },
      ];
      const ns = cross + COST.kernelRead + count * COST.copyPerByte + COST.userCall + want * COST.copyPerByte;
      return {
        ...st, appReads: st.appReads + 1, buffered: st.buffered + count - want, stepSyscalls: st.stepSyscalls + 1,
        trace: { kind: "read", want, syscall: true, count, hops, ns }, traceId: st.traceId + 1,
      };
    }
    case "replay": {
      const r = replay(st.buffer, st.kpti, st.strace);
      const same = (x: ReplayResult) => x.buffer === r.buffer && x.kpti === r.kpti && x.strace === r.strace;
      return { ...st, last: r, runs: [...st.runs.filter((x) => !same(x)), r] };
    }
  }
}

/** The plain baseline and the 64 KiB run, if the reader has done both, for the result line. */
export function comparison(runs: ReplayResult[]): { slow: ReplayResult; fast: ReplayResult; speedup: number } | null {
  const plain = runs.filter((r) => !r.kpti && !r.strace);
  const slow = plain.find((r) => r.buffer === 0);
  const fast = plain.filter((r) => r.buffer > 0).sort((a, b) => a.ms - b.ms)[0];
  if (!slow || !fast) return null;
  return { slow, fast, speedup: slow.ms / fast.ms };
}
