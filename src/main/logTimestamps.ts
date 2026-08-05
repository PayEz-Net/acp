/**
 * Timestamp every main-process console line.
 *
 * The ACP log is the primary forensic record for turn-lifecycle faults, and it
 * had no clock in it. Two lines that sit next to each other in the file may be
 * three milliseconds apart or three minutes apart, and nothing distinguishes
 * them — which is exactly how a cancel that landed 2m41s into a productive turn
 * was read as an instant drop (Jon 2026-08-05). Every latency question the log
 * is asked — did the watchdog fire early, how long did the restart take, was
 * the human waiting 6 seconds or 60 — needs this.
 *
 * Imported for side effect from index.ts BEFORE anything else logs.
 */

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';

let installed = false;

/** Local wall-clock time, matching what the human sees on the app's own clock. */
function stamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

export function installLogTimestamps(): void {
  // Electron reloads and test harnesses can import this twice; double-wrapping
  // would prefix two clocks per line.
  if (installed) return;
  installed = true;

  const methods: ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug'];
  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      original(stamp(), ...args);
    };
  }
}
