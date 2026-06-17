/**
 * #120 enforcement guard (make-the-rule-mechanically-true).
 *
 * The durable-rounds check-in board reads round.reports[] and FAILS LOUD on a
 * read failure — it must NEVER fall back to the in-memory event ring (acpStore),
 * which is the "retirement residue" the W3/W4 spec forbids (Aurum #2: no silent
 * fallback to the ring as a board source). This test mechanically asserts the
 * rounds store + board surface never import acpStore, so the fallback can't
 * silently regrow in a future edit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILES = [
  './standupRoundsStore.ts',
  '../components/Standup/StandupRoundBoard.tsx',
];

describe('#120 standup rounds — acpStore-free guard', () => {
  for (const rel of FILES) {
    it(`${rel} never imports the in-memory event ring (acpStore)`, () => {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      // No import of an acpStore module, and no reference to its hook.
      expect(src, `${rel} must not import acpStore`).not.toMatch(/from\s+['"][^'"]*acpStore['"]/);
      expect(src, `${rel} must not reference useAcpStore`).not.toMatch(/useAcpStore/);
    });
  }
});
