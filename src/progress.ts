// Scan progress feedback (relieves the "long silence looks frozen" anxiety).
// Key constraint: writes to stderr, never polluting stdout --json / --report output.
// TTY (terminal): single-line spinner + "X/Y" progress + current detector + elapsed time, then a brief timing summary at the end.
// Non-TTY (pipe/redirect/CI): switch to one line of plain text per event (play start / check done) for easy log viewing.
// All glyphs are ASCII-safe on Windows (see glyphs.ts) so the live progress never mojibake under any shell.

import { G, clean } from "./glyphs";

const SPINNERS = G.spinner;

export class ScanProgress {
  private tty: boolean;
  private total: number;
  private doneCount = 0;
  private started = Date.now();
  private inflight = new Set<string>();
  private timings: { name: string; ms: number; err: boolean }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private extra = "";

  constructor(total: number, tty = !!process.stderr.isTTY) {
    this.total = total;
    this.tty = tty;
    if (this.tty) this.timer = setInterval(() => this.render(), 110);
  }

  setTotal(n: number): void {
    this.total = n;
  }

  /** Sub-status inside a detector (e.g. "scanning conda/base pip packages"), merged into the status line under TTY. */
  sub(msg: string): void {
    if (!this.tty) {
      process.stderr.write("    " + clean(msg) + "\n");
      return;
    }
    this.extra = msg;
    this.render();
  }

  start(name: string): void {
    this.inflight.add(name);
    if (!this.tty) process.stderr.write(`${G.play} ${clean(name)}\n`);
    else this.render();
  }

  done(name: string, ms: number, err = false): void {
    this.inflight.delete(name);
    this.doneCount++;
    this.timings.push({ name, ms, err });
    if (!this.tty) process.stderr.write(`${err ? G.cross : G.check} ${clean(name)} (${(ms / 1000).toFixed(1)}s)\n`);
    else this.render();
  }

  private render(): void {
    if (!this.tty) return;
    const t = ((Date.now() - this.started) / 1000).toFixed(1);
    const spin = SPINNERS[Math.floor(Date.now() / 110) % SPINNERS.length];
    const cur =
      clean(([...this.inflight].join("+") + (this.extra ? G.dot + " " + this.extra : "")) || G.mdash);
    const msg = `${spin} scanning ${this.doneCount}/${this.total} ${G.dot} running: ${cur} ${G.dot} elapsed ${t}s`;
    process.stderr.write(`\r\x1b[K${msg}`);
  }

  /** End of scan: stop the spinner, clear the status line, print a brief timing summary to stderr. */
  finish(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.tty) process.stderr.write(`\r\x1b[K`);
    if (this.timings.length) {
      const w = Math.max(1, ...this.timings.map((t) => t.name.length));
      for (const t of this.timings)
        process.stderr.write(`  ${t.err ? G.cross : G.check} ${clean(t.name).padEnd(w)}  ${t.ms >= 1000 ? (t.ms / 1000).toFixed(1) + "s" : t.ms + "ms"}\n`);
      const total = ((Date.now() - this.started) / 1000).toFixed(1);
      process.stderr.write(`  \x1b[2mscan complete, took ${total}s\x1b[0m\n`);
    }
  }
}
