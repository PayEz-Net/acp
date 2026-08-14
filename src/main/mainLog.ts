/**
 * Main-process log file (kanban 185035).
 *
 * WHY THIS EXISTS. Every diagnostic in the main process was a transient
 * console.warn written to a stdout nobody is attached to — gone the moment it
 * was emitted. Two investigations in one day (117107 F2, 140734) dead-ended at
 * that same wall: the cause of a failure existed only as a console line nobody
 * could read after the fact. This module gives those lines a durable sink.
 *
 * DESIGN NOTES
 *  - NO new dependency and no new instrumentation to design. The existing
 *    console.log/warn/error calls stay exactly as they are; this tees them to
 *    a file. Nothing to remember to switch on, nothing for a future call site
 *    to do differently.
 *  - Append-only, size-capped, rotating: `main.log` rolls to `main.log.1`
 *    (overwritten) at the cap, so total footprint is bounded at 2x the cap.
 *    An unbounded log trades an instrumentation gap for a disk-full outage.
 *  - NEVER throws. A logging failure must not crash the process it observes —
 *    every write is wrapped, and a broken sink degrades to the old behavior
 *    (console only) rather than becoming its own incident.
 *  - Writes are synchronous on purpose: ordering between the console line and
 *    the file line stays exact, and a line emitted during a crash path still
 *    lands. Volume here is diagnostic-level, not terminal-stream.
 */
import * as fs from 'fs';
import * as path from 'path';
import { format } from 'util';

/** Per-file cap; total on-disk footprint is bounded at 2x this (current + .1). */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

type Level = 'log' | 'warn' | 'error';

let logFilePath: string | null = null;
let maxBytes = DEFAULT_MAX_BYTES;
let currentBytes = 0;
let installed = false;

const original: Record<Level, (...args: unknown[]) => void> = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

/**
 * Point the log at `<userDataDir>/logs/main.log` and tee console into it.
 * Returns the resolved path so the caller can name it at boot (184949: this
 * app has two candidate userData roots on one box, so the resolved path is
 * itself diagnostic information). Safe to call again — a second call is a
 * no-op returning the existing path.
 */
export function initMainLog(userDataDir: string, capBytes = DEFAULT_MAX_BYTES): string {
  if (logFilePath) return logFilePath;
  const dir = path.join(userDataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, 'main.log');
  maxBytes = capBytes;
  try {
    currentBytes = fs.statSync(logFilePath).size;
  } catch {
    currentBytes = 0; // first boot, or unreadable — start counting from zero
  }
  installTee();
  return logFilePath;
}

export function getMainLogPath(): string | null {
  return logFilePath;
}

function rotate(): void {
  if (!logFilePath) return;
  const prev = `${logFilePath}.1`;
  try {
    fs.unlinkSync(prev);
  } catch {
    /* no previous rotation — fine */
  }
  try {
    fs.renameSync(logFilePath, prev);
  } catch {
    /* current file vanished under us — the next append recreates it */
  }
  currentBytes = 0;
}

function writeLine(level: Level, args: unknown[]): void {
  if (!logFilePath) return;
  try {
    const line = `[${new Date().toISOString()}] [${level}] ${format(...args)}\n`;
    const bytes = Buffer.byteLength(line);
    if (currentBytes + bytes > maxBytes) rotate();
    fs.appendFileSync(logFilePath, line, 'utf8');
    currentBytes += bytes;
  } catch {
    /* the sink is broken; the console copy already happened, degrade to it */
  }
}

function installTee(): void {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      // Console FIRST: the original behavior is the primary contract, the file
      // is the copy. If the copy ever throws (it is wrapped not to), the
      // console line has already happened.
      original[level](...args);
      writeLine(level, args);
    };
  }
}

/** Restore console and reset module state. Tests only. */
export function resetMainLogForTests(): void {
  if (installed) {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  installed = false;
  logFilePath = null;
  maxBytes = DEFAULT_MAX_BYTES;
  currentBytes = 0;
}
