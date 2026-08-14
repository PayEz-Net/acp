import { describe, it, expect } from 'vitest';
import {
  computeSpawnStaggerMs,
  DEFAULT_SPAWN_STAGGER_MS,
  SPAWN_STAGGER_JITTER_MS,
  MIN_NON_CLAUDE_SPAWN_STAGGER_MS,
} from './spawnStagger';

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('computeSpawnStaggerMs (177737)', () => {
  it('spaces claude spawns too — the herd was claude-side, zero stagger before', () => {
    // rand() = 0 → no jitter; the BASE alone must be nonzero for claude.
    expect(computeSpawnStaggerMs('claude', () => 0, NO_ENV)).toBe(DEFAULT_SPAWN_STAGGER_MS);
  });

  it('keeps the non-claude 3000ms config-init floor even if the knob is set lower', () => {
    expect(computeSpawnStaggerMs('kimi', () => 0, { ACP_SPAWN_STAGGER_MS: '500' })).toBe(
      MIN_NON_CLAUDE_SPAWN_STAGGER_MS,
    );
  });

  it('honors the ACP_SPAWN_STAGGER_MS override for claude, including explicit 0', () => {
    expect(computeSpawnStaggerMs('claude', () => 0, { ACP_SPAWN_STAGGER_MS: '10000' })).toBe(10000);
    expect(computeSpawnStaggerMs('claude', () => 0, { ACP_SPAWN_STAGGER_MS: '0' })).toBe(0);
  });

  it('ignores unparsable and negative overrides rather than crashing boot', () => {
    expect(computeSpawnStaggerMs('claude', () => 0, { ACP_SPAWN_STAGGER_MS: 'fast' })).toBe(
      DEFAULT_SPAWN_STAGGER_MS,
    );
    expect(computeSpawnStaggerMs('claude', () => 0, { ACP_SPAWN_STAGGER_MS: '-50' })).toBe(
      DEFAULT_SPAWN_STAGGER_MS,
    );
  });

  it('jitter stays within [0, 2000] and is added on top of the base', () => {
    const max = computeSpawnStaggerMs('claude', () => 0.99999, NO_ENV);
    expect(max).toBeGreaterThanOrEqual(DEFAULT_SPAWN_STAGGER_MS);
    expect(max).toBeLessThanOrEqual(DEFAULT_SPAWN_STAGGER_MS + SPAWN_STAGGER_JITTER_MS);
  });
});
