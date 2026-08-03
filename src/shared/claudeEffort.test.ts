/**
 * B-3 — `xhigh` must survive the spawn boundaries.
 *
 * WHY THIS FILE EXISTS (must-fail-first, B-6):
 * The spawn-command builder already emitted `--effort xhigh` correctly, and
 * `CLAUDE_EFFORTS` already listed it — so every existing test passed. But the
 * value never got that far. Both spawn boundaries re-listed the levels by hand:
 *
 *   spawn-orchestrator.ts:383  (team spawn, lifecycle RUNNING)
 *   lifecycle-server.ts:141    (manual per-pane spawn, POST /spawn)
 *
 *   const effort = (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max')
 *     ? raw : undefined;
 *
 * `xhigh` matched none of them, so a stored `xhigh` became `undefined` = inherit
 * the global default. The picker could offer it, the DB could hold it, the
 * builder could render it, and the child still never saw it. Asserting the
 * builder's output cannot catch this — the defect is upstream of the builder.
 *
 * Neither boundary is importable from a test (both reach electron's `app`
 * transitively via ./pty → env.ts), so the narrowing lives in shared/types.ts
 * and is asserted here. Both call sites now delegate to it; the grep in the last
 * test is what keeps that true.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  CLAUDE_EFFORTS,
  isClaudeEffort,
  narrowClaudeEffort,
  CLAUDE_MODELS,
  CLAUDE_MODEL_LABELS,
} from './types';

describe('narrowClaudeEffort — the shared spawn-boundary guard', () => {
  it('passes EVERY supported level through unchanged, xhigh included', () => {
    // The regression that motivated this file: xhigh specifically.
    expect(narrowClaudeEffort('xhigh')).toBe('xhigh');
    for (const level of CLAUDE_EFFORTS) {
      expect(narrowClaudeEffort(level)).toBe(level);
    }
  });

  it('returns undefined — not a substituted default — for junk', () => {
    // undefined means "defer to the single global default" at the spawn site.
    // Returning 'high' here would be a second authority on the default.
    for (const junk of ['', '  ', 'ultra', 'HIGH', 'xhigh ', null, undefined, 7, {}]) {
      expect(narrowClaudeEffort(junk)).toBeUndefined();
    }
  });

  it('is case- and whitespace-strict, because the CLI is', () => {
    expect(isClaudeEffort('High')).toBe(false);
    expect(isClaudeEffort(' high')).toBe(false);
    expect(isClaudeEffort('high')).toBe(true);
  });
});

describe('CLAUDE_MODELS — the model picker catalogue', () => {
  it('offers exactly the aliases verified on the wire against claude 2.1.220', () => {
    expect([...CLAUDE_MODELS]).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('labels every alias, so none can render as a blank option', () => {
    for (const model of CLAUDE_MODELS) {
      expect(CLAUDE_MODEL_LABELS[model]).toBeTruthy();
    }
    expect(Object.keys(CLAUDE_MODEL_LABELS)).toHaveLength(CLAUDE_MODELS.length);
  });
});

describe('the spawn boundaries delegate instead of re-listing the levels', () => {
  // A grep, not a behavioural assertion, because neither module can be
  // imported here. It is still the assertion that matters: the defect was a
  // duplicated list, so what has to stay true is that no duplicate exists.
  const BOUNDARIES = [
    'src/main/spawn-orchestrator.ts',
    'src/main/lifecycle-server.ts',
  ];

  for (const file of BOUNDARIES) {
    it(`${file} narrows via the shared guard`, () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(src).toMatch(/narrowClaudeEffort\(/);
    });

    it(`${file} does not hand-write the effort union`, () => {
      const src = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      // The exact shape that dropped xhigh twice.
      expect(src).not.toMatch(/===\s*'medium'/);
    });
  }
});
