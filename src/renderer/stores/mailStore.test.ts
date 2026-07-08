import { describe, it, expect } from 'vitest';
import { resolveMailAlias, unresolveMailAlias } from './mailStore';

describe('mailStore aliases', () => {
  it('resolves NextPert to its registered executor instance', () => {
    expect(resolveMailAlias('NextPert')).toBe('Nextpert-Scout');
  });

  it('leaves non-aliased agents unchanged', () => {
    expect(resolveMailAlias('BAPert')).toBe('BAPert');
    expect(resolveMailAlias('QAPert')).toBe('QAPert');
  });

  it('reverse-maps an aliased name back to the UI-facing agent', () => {
    expect(unresolveMailAlias('Nextpert-Scout')).toBe('NextPert');
    expect(unresolveMailAlias('BAPert')).toBe('BAPert');
  });
});
