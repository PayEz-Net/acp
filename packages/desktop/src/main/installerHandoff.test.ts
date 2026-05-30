/**
 * COL-6 M5.1 — installer→app handoff bridge. Proves the consent-first
 * contract: consent is seeded ONLY when the installer RECORDED it
 * (never inferred/silent — spec §2.3/§8 AC7), root recorded once,
 * idempotent, malformed handoff = no-op.
 */
import { describe, it, expect } from 'vitest';
import type { AppSettings } from '../shared/types';
import { parseHandoff, applyHandoff } from './installerHandoff';

function settingsHarness(initial: Partial<AppSettings> = {}) {
  let s = { ...initial } as AppSettings;
  return {
    get: () => s,
    set: (patch: Partial<AppSettings>) => { s = { ...s, ...patch }; },
    snapshot: () => s,
  };
}

describe('parseHandoff', () => {
  it('valid handoff parses', () => {
    expect(parseHandoff(JSON.stringify({ workspaceRoot: 'C:\\ws', colonizationConsented: true, installerVersion: '1.2.3' })))
      .toEqual({ workspaceRoot: 'C:\\ws', colonizationConsented: true, installerVersion: '1.2.3' });
  });
  it('rejects malformed / missing / wrong-typed', () => {
    for (const raw of ['not json', '{}', JSON.stringify({ workspaceRoot: '' , colonizationConsented: true }),
      JSON.stringify({ workspaceRoot: 'C:\\ws' }), JSON.stringify({ workspaceRoot: 'C:\\ws', colonizationConsented: 'yes' })]) {
      expect(parseHandoff(raw)).toBeNull();
    }
  });
});

describe('applyHandoff (consent-first, idempotent)', () => {
  it('seeds consent + records root ONLY when installer recorded consent', () => {
    const h = settingsHarness();
    const r = applyHandoff({ workspaceRoot: 'C:\\ws', colonizationConsented: true }, h.get, h.set);
    expect(r).toEqual({ seededConsent: true, recordedRoot: true });
    expect(h.snapshot().colonizationConsent).toBe(true);
    expect(h.snapshot().installerWorkspaceRoot).toBe('C:\\ws');
  });
  it('does NOT seed consent when installer did NOT record it (no silent auto-consent)', () => {
    const h = settingsHarness();
    const r = applyHandoff({ workspaceRoot: 'C:\\ws', colonizationConsented: false }, h.get, h.set);
    expect(r.seededConsent).toBe(false);
    expect(h.snapshot().colonizationConsent).toBeUndefined();
    expect(h.snapshot().installerWorkspaceRoot).toBe('C:\\ws'); // root still recorded
  });
  it('idempotent — re-apply changes nothing', () => {
    const h = settingsHarness({ colonizationConsent: true, installerWorkspaceRoot: 'C:\\ws' });
    const r = applyHandoff({ workspaceRoot: 'C:\\ws', colonizationConsented: true }, h.get, h.set);
    expect(r).toEqual({ seededConsent: false, recordedRoot: false });
  });
});
