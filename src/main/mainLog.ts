import { app } from 'electron';
import fs from 'fs';
import path from 'path';

/**
 * Persistent main-process log (card 185035 — the INSTRUMENT GAP that keeps
 * biting: main has NO log, so overnight we had four agent runtimes die with
 * zero evidence and a "restarting runtime" claim nobody could verify).
 *
 * Tees console.log/warn/error to <userData>/acp-main.log, ISO-timestamped.
 * The console still prints as before (dev terminal sees the same lines).
 * Rotates at boot: if the log exceeds 5 MB it becomes acp-main.old.log
 * (one generation — good enough for post-mortems, bounded on disk).
 *
 * Call ONCE, as early as possible in main boot, before anything else logs.
 * Best-effort by contract: a logging failure must never break the app.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function initMainLog(): void {
  try {
    const logPath = path.join(app.getPath('userData'), 'acp-main.log');
    try {
      if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
        fs.renameSync(logPath, logPath.replace(/\.log$/, '.old.log'));
      }
    } catch { /* no prior log — fine */ }

    const stream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.write(`\n=== main log opened ${new Date().toISOString()} pid=${process.pid} ===\n`);

    const tee = (original: (...args: unknown[]) => void, level: string) =>
      function (this: unknown, ...args: unknown[]) {
        try {
          const line = args
            .map((a) => {
              if (typeof a === 'string') return a;
              try { return JSON.stringify(a); } catch { return String(a); }
            })
            .join(' ');
          stream.write(`${new Date().toISOString()} [${level}] ${line}\n`);
        } catch { /* logging must never throw into app code */ }
        original.apply(console, args);
      };

    console.log = tee(console.log, 'log');
    console.warn = tee(console.warn, 'warn');
    console.error = tee(console.error, 'error');

    const flush = () => { try { stream.end(); } catch { /* shutting down */ } };
    app.on('before-quit', flush);
    process.on('exit', flush);
  } catch { /* best-effort: no log file, no crash */ }
}
