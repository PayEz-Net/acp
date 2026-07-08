import { describe, it, expect } from 'vitest';
import { filterAcpProse } from './acpProseGuard';

describe('filterAcpProse', () => {
  it('removes inline token counter fragments', () => {
    const input = 'Run 3 prompts in 2026. 14 tokens : here. Version 1.2.3 is OK.';
    expect(filterAcpProse(input)).toBe('Run 3 prompts in 2026. here. Version 1.2.3 is OK.');
  });

  it('drops lines that consist only of token counters or timing artifacts', () => {
    const input = ['Before', '13 tokens :', '321:46', ':58', "70':", '1s · 82 tokens:96', 'After'].join('\n');
    expect(filterAcpProse(input)).toBe('Before\nAfter');
  });

  it('preserves legitimate prose with numbers and times', () => {
    const input = 'Meet at 12:30. The ratio is 3:1. Cost is $70.';
    expect(filterAcpProse(input)).toBe(input);
  });

  it('strips ANSI escape and backspace mechanics', () => {
    const input = '\u001b[32mapplied\u001b[0m\r\nsame\b\b\bturn\n\u001b[1K slipping';
    expect(filterAcpProse(input)).toBe('applied\nsturn\n slipping');
  });

  it('deduplicates consecutive identical paragraphs', () => {
    const input = 'Hello world.\n\nHello world.\n\nSomething else.';
    expect(filterAcpProse(input)).toBe('Hello world.\n\nSomething else.');
  });

  it('does not deduplicate non-consecutive repeated paragraphs', () => {
    const input = 'Hello world.\n\nSomething else.\n\nHello world.';
    expect(filterAcpProse(input)).toBe(input);
  });
});
