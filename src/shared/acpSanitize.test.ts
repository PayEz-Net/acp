import { describe, it, expect } from 'vitest';
import { sanitizeKimiContent } from './acpSanitize';

describe('sanitizeKimiContent', () => {
  it('removes clustered streaming metadata artifacts', () => {
    const input = [
      'Before',
      '13 tokens :',
      '321:46',
      ':58',
      "70':",
      '1s · 82 tokens:96',
      '106 tokens: : 18',
      '31',
      '42',
      '30394',
      'After',
    ].join('\n');

    expect(sanitizeKimiContent(input)).toBe('Before\nAfter');
  });

  it('removes inline token counters without stripping legitimate numbers', () => {
    const input = 'Run 3+ back-and-forth prompts in 2026. 14 tokens : here. Version 1.2.3 is OK.';

    expect(sanitizeKimiContent(input)).toBe('Run 3+ back-and-forth prompts in 2026. here. Version 1.2.3 is OK.');
  });

  it('preserves standalone numbers when no artifacts are present', () => {
    const input = [
      'The answer is 42.',
      'A small count is 123.',
      'A year is 2026.',
      'Version 1.2.3 works.',
    ].join('\n');

    expect(sanitizeKimiContent(input)).toBe(input);
  });

  it('removes clustered standalone numbers only alongside other status artifacts', () => {
    const input = 'Before\n321:46\n31\n42\n30394\nAfter';

    expect(sanitizeKimiContent(input)).toBe('Before\nAfter');
  });

  it('does not remove a legitimate lone short answer', () => {
    expect(sanitizeKimiContent('42')).toBe('42');
    expect(sanitizeKimiContent('No\n42')).toBe('No\n42');
  });

  it('collapses blank lines left by removed artifacts', () => {
    const input = 'Start\n13 tokens :\n:58\nEnd';

    expect(sanitizeKimiContent(input)).toBe('Start\nEnd');
  });

  it('preserves prose with colons and times in context', () => {
    const input = 'Meet at 12:30. The ratio is 3:1. Cost is $70.';

    expect(sanitizeKimiContent(input)).toBe(input);
  });

  it('removes timed token counters with bullet separators', () => {
    expect(sanitizeKimiContent('1s · 82 tokens:96')).toBe('');
    expect(sanitizeKimiContent('2m: 14 tokens')).toBe('');
    expect(sanitizeKimiContent('prefix 3h · 99 tokens suffix')).toBe('prefix suffix');
  });

  it('preserves 3-4 digit standalone numbers even in artifact context', () => {
    const input = 'Before\n321:46\n123\n2026\nAfter';

    expect(sanitizeKimiContent(input)).toBe('Before\n123\n2026\nAfter');
  });
});
