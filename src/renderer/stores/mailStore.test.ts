import { describe, it, expect } from 'vitest';
import { resolveMailAlias, unresolveMailAlias } from './mailStore';

describe('mailStore aliases', () => {
  it('leaves all agents unchanged now that the registry resolves them directly', () => {
    expect(resolveMailAlias('NextPert')).toBe('NextPert');
    expect(resolveMailAlias('BAPert')).toBe('BAPert');
    expect(resolveMailAlias('QAPert')).toBe('QAPert');
  });

  it('reverse-maps a non-aliased name back to itself', () => {
    expect(unresolveMailAlias('NextPert')).toBe('NextPert');
    expect(unresolveMailAlias('BAPert')).toBe('BAPert');
  });
});
