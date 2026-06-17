/**
 * agentLabels unit tests — AC-4 dual-label.
 *
 * Spec ref: `acp-dynamic-team-loading-v1-spec.md` §7 AC-4.
 */
import { describe, expect, it } from 'vitest';
import { archetypeLabelFor } from './agentLabels';

describe('archetypeLabelFor — AC-4 dual-label', () => {
  it('returns archetype name when displayName has been renamed', () => {
    expect(archetypeLabelFor({ name: 'BAPert', displayName: 'Alex' })).toBe('BAPert');
  });

  it('returns null when displayName matches archetype (default state, no rename)', () => {
    expect(archetypeLabelFor({ name: 'BAPert', displayName: 'BAPert' })).toBeNull();
  });

  it('returns null when displayName is empty string', () => {
    expect(archetypeLabelFor({ name: 'BAPert', displayName: '' })).toBeNull();
  });

  it('handles multi-word display names', () => {
    expect(archetypeLabelFor({ name: 'DotNetPert', displayName: 'Dr. Jen Smith' })).toBe('DotNetPert');
  });

  it('case-sensitive comparison — different case is treated as a rename', () => {
    expect(archetypeLabelFor({ name: 'BAPert', displayName: 'bapert' })).toBe('BAPert');
  });
});
