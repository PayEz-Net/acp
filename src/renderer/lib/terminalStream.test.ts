import { describe, it, expect } from 'vitest';
import { TerminalStreamNormalizer } from './terminalStream';
import { useAgentStatusStore } from '../stores/agentStatusStore';

function makeLine(line: string, provider = 'claude', terminalId = 't1', ts = new Date().toISOString()) {
  return {
    agent: 'Agent',
    terminal_id: terminalId,
    provider,
    line,
    ts,
  };
}

describe('TerminalStreamNormalizer', () => {
  it('strips ANSI and applies provider adapter', () => {
    const n = new TerminalStreamNormalizer();
    const out = n.process(makeLine('\u001b[32mhello\u001b[0m'));
    expect(out?.line).toBe('hello');
  });

  it('collapses consecutive Claude spinner frames to one line', () => {
    const n = new TerminalStreamNormalizer();
    const frames = ['⠋ Reading files...', '⠙ Reading files...', '⠹ Reading files...'];
    const results = frames.map((f) => n.process(makeLine(f, 'claude')));
    expect(results[0]?.line).toBe('Reading files...');
    expect(results[1]).toBeNull();
    expect(results[2]).toBeNull();
  });

  it('treats colored-circle spinner frames as live thinking placeholders', () => {
    const n = new TerminalStreamNormalizer();
    const frames = ['🟡🟣', '🟣🟡', '🟡🟣'];
    const results = frames.map((f) => n.process(makeLine(f, 'kimi')));
    expect(results[0]?.line).toBe('Thinking...');
    expect(results[0]?.thinkingLive).toBe(true);
    expect(results[1]?.thinkingLive).toBe(true);
    expect(results[2]?.thinkingLive).toBe(true);
  });

  it('treats colored-square and moon spinner frames as live thinking placeholders', () => {
    const n = new TerminalStreamNormalizer();
    const frames = ['🟨🟪', '🟪🟨', '🌕🌑'];
    const results = frames.map((f) => n.process(makeLine(f, 'kimi')));
    expect(results[0]?.line).toBe('Thinking...');
    expect(results.every((r) => r?.thinkingLive)).toBe(true);
  });

  it('treats any pure spinner/status-glyph line as a live thinking placeholder', () => {
    const n = new TerminalStreamNormalizer();
    const frames = ['●●', '●○', '◐◑'];
    const results = frames.map((f) => n.process(makeLine(f, 'kimi')));
    expect(results[0]?.line).toBe('Thinking...');
    expect(results.every((r) => r?.thinkingLive)).toBe(true);
  });

  it('starts thinking mode on thinking labels', () => {
    const n = new TerminalStreamNormalizer();
    const out = n.process(makeLine('Thinking...', 'claude', 't1'));
    expect(out?.line).toBe('Thinking...');
    expect(out?.thinkingLive).toBe(true);
    expect(out?.thinking).toBe('');
  });

  it('updates the thinking label while keeping accumulated content', () => {
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Thinking...', 'claude', 't1'));
    n.process(makeLine('step one', 'claude', 't1'));
    const updated = n.process(makeLine('Analyzing...', 'claude', 't1'));
    expect(updated?.line).toBe('Analyzing...');
    expect(updated?.thinkingLive).toBe(true);
    expect(updated?.thinking).toContain('step one');
  });

  it('replaces Kimi image placeholders with ⟨image⟩', () => {
    const n = new TerminalStreamNormalizer();
    const out = n.process(makeLine('[IMAGE: screenshot.png]', 'kimi'));
    expect(out?.line).toBe('⟨image⟩');
  });

  it('normalizes Codex model labels', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('codex-mini-latest', 'codex'))?.line).toBe('Codex');
    expect(n.process(makeLine('Running codex-mini now', 'codex'))?.line).toBe('Running Codex now');
  });

  it('collapses blank lines to at most two consecutive', () => {
    const n = new TerminalStreamNormalizer();
    // First two blank lines are emitted.
    expect(n.process(makeLine(''))?.line).toBe('');
    expect(n.process(makeLine(''))?.line).toBe('');
    // Third consecutive blank line is dropped.
    expect(n.process(makeLine(''))).toBeNull();
    // A non-blank line resets the counter.
    expect(n.process(makeLine('A'))?.line).toBe('A');
    // Counter resets, so the next two blanks are emitted again.
    expect(n.process(makeLine(''))?.line).toBe('');
    expect(n.process(makeLine('   '))?.line).toBe('');
    expect(n.process(makeLine(''))).toBeNull();
  });

  it('resets dedup after a different line appears', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:01.000Z').toISOString();
    const t2 = new Date('2026-07-03T12:00:02.000Z').toISOString();
    expect(n.process(makeLine('A', 'claude', 't1', t0))?.line).toBe('A');
    expect(n.process(makeLine('B', 'claude', 't1', t1))?.line).toBe('B');
    expect(n.process(makeLine('A', 'claude', 't1', t2))?.line).toBe('A');
  });

  it('drops status-glyph-only lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('✓'))).toBeNull();
    expect(n.process(makeLine('✓'))).toBeNull();
    expect(n.process(makeLine('  ✓  '))).toBeNull();
    expect(n.process(makeLine('✓ ✓'))).toBeNull();
    // A non-status line still reaches the stream.
    expect(n.process(makeLine('done'))?.line).toBe('done');
    expect(n.process(makeLine('✓'))).toBeNull();
  });

  it('accumulates thinking content and attaches it to the answer line', () => {
    const n = new TerminalStreamNormalizer();
    const label = n.process(makeLine('Thinking...', 'claude', 't1'));
    expect(label?.line).toBe('Thinking...');
    expect(label?.thinkingLive).toBe(true);

    const content = n.process(makeLine('first thought', 'claude', 't1'));
    expect(content?.thinkingLive).toBe(true);
    expect(content?.thinking).toContain('first thought');

    n.process(makeLine('', 'claude', 't1')); // blank separator ends thinking
    const answer = n.process(makeLine('Here is the answer', 'claude', 't1'));
    expect(answer?.line).toBe('Here is the answer');
    expect(answer?.thinking).toContain('first thought');
    expect(answer?.thinkingLive).toBe(false);
  });

  it('detects <thinking>...</thinking> markers', () => {
    const n = new TerminalStreamNormalizer();
    const start = n.process(makeLine('<thinking>', 'claude', 't1'));
    expect(start?.thinkingLive).toBe(true);

    n.process(makeLine('inner monologue', 'claude', 't1'));
    const end = n.process(makeLine('</thinking>', 'claude', 't1'));
    expect(end?.thinking).toContain('inner monologue');
    expect(end?.thinkingLive).toBe(false);
  });

  it('does not collapse a real sentence containing "thinking"', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('I was thinking about this'))?.line).toBe('I was thinking about this');
  });

  it('drops pure separator lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('---'))).toBeNull();
    expect(n.process(makeLine('---'))).toBeNull();
    expect(n.process(makeLine('=========='))).toBeNull();
    expect(n.process(makeLine('~~~~~~~~~~'))).toBeNull();
    // A line that merely contains dashes but has real words should not collapse.
    expect(n.process(makeLine('git diff --cached'))?.line).toBe('git diff --cached');
    expect(n.process(makeLine('--- input ---'))).toBeNull();
  });

  it('does not collapse thinking labels that appear as real content', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('I am thinking about the best approach'))?.line).toBe(
      'I am thinking about the best approach',
    );
    expect(n.process(makeLine('Thinking...'))?.line).toBe('Thinking...');
  });

  it('drops context-percent footer lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('context: 69.4%'))).toBeNull();
    expect(n.process(makeLine('context: 70.1%'))).toBeNull();
    expect(n.process(makeLine('Context: 72.0%'))).toBeNull();
  });

  it('drops footer lines before and after real content', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:01.000Z').toISOString();
    const t2 = new Date('2026-07-03T12:00:06.000Z').toISOString();
    expect(n.process(makeLine('context: 69.4%', 'claude', 't1', t0))).toBeNull();
    expect(n.process(makeLine('Here is the answer', 'claude', 't1', t1))?.line).toBe('Here is the answer');
    // Footer variants are always dropped, even within the previous 5-second window.
    expect(n.process(makeLine('context: 10%', 'claude', 't1', t1))).toBeNull();
    // After the window expires the footer is still dropped.
    expect(n.process(makeLine('context: 11%', 'claude', 't1', t2))).toBeNull();
  });

  it('drops Kimi keybinding hint lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('ctrl-o: editor'))).toBeNull();
    expect(n.process(makeLine('ctrl-x: toggle mode'))).toBeNull();
    expect(n.process(makeLine('shift-tab: pan mode'))).toBeNull();
    expect(n.process(makeLine('@: mention files'))).toBeNull();
    expect(n.process(makeLine('jnewline'))).toBeNull();
    // A non-hint line still reaches the stream.
    expect(n.process(makeLine('real output'))?.line).toBe('real output');
  });

  it('ignores footer and separator redraws while in a thinking block', () => {
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Thinking...', 'claude', 't1'));
    n.process(makeLine('step one', 'claude', 't1'));
    const footerDuringThinking = n.process(makeLine('context: 33.8%', 'claude', 't1'));
    expect(footerDuringThinking?.thinkingLive).toBe(true);
    expect(footerDuringThinking?.thinking).not.toContain('context:');
    const separatorDuringThinking = n.process(makeLine('— input —', 'claude', 't1'));
    expect(separatorDuringThinking?.thinkingLive).toBe(true);
    n.process(makeLine('', 'claude', 't1'));
    const answer = n.process(makeLine('Here is the answer', 'claude', 't1'));
    expect(answer?.line).toBe('Here is the answer');
    expect(answer?.thinking).not.toContain('context:');
    expect(answer?.thinking).not.toContain('— input');
  });

  it('drops footer bars with mixed metadata entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('| Context: 69.4% | Tools: 3 |'))).toBeNull();
    expect(n.process(makeLine('| Context: 70.0% | Tools: 3 |'))).toBeNull();
    expect(n.process(makeLine('| Context: 71.0% | Tools: 4 |'))).toBeNull();
  });

  it('does not treat prose containing context percentage as footer noise', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('The context is about 69.4% full'))?.line).toBe(
      'The context is about 69.4% full',
    );
  });

  it('treats prompt-prefixed thinking labels as thinking mode', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('│ › Thinking'))?.line).toBe('│ › Thinking');
    expect(n.process(makeLine('│ › Thinking'))?.thinkingLive).toBe(true);
    expect(n.process(makeLine('> Analyzing...'))?.thinkingLive).toBe(true);
  });

  it('drops yolo agent banner and footer metadata entirely', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:01.000Z').toISOString();
    const t2 = new Date('2026-07-03T12:00:02.000Z').toISOString();
    const t3 = new Date('2026-07-03T12:00:03.000Z').toISOString();
    expect(n.process(makeLine('yolo agent (K2.7 Code ●) E:\\repos', 'kimi', 't1', t0))).toBeNull();
    expect(n.process(makeLine('real command output', 'kimi', 't1', t1))?.line).toBe('real command output');
    expect(n.process(makeLine('context: 33.8%', 'kimi', 't1', t2))).toBeNull();
    expect(n.process(makeLine('(88.7k/262.1k)', 'kimi', 't1', t3))).toBeNull();
  });

  it('drops Kimi Code CLI status bar lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(
      n.process(makeLine('yolo agent (K2.7 Code ●) E:\\repos @: mention files')),
    ).toBeNull();
    expect(
      n.process(makeLine('yolo agent (K2.7 Code ●) E:\\repos @: mention files')),
    ).toBeNull();
  });

  it('drops token-usage footer lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('(182k/262.1k)'))).toBeNull();
    expect(n.process(makeLine('(183k/262.1k)'))).toBeNull();
  });

  it('drops em-dash input prompts entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('— input'))).toBeNull();
    expect(n.process(makeLine('— input'))).toBeNull();
  });

  it('drops input prompts that include typed text entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('— input hello world'))).toBeNull();
    expect(n.process(makeLine('— input hello worl'))).toBeNull();
    expect(n.process(makeLine('— input hello'))).toBeNull();
  });

  it('drops every junk pattern visible in thisishowwecomeout.jpg', () => {
    const n = new TerminalStreamNormalizer();
    const junk = [
      'yolo agent (K2.7 Code ●) E:\\repos',
      'yolo agent (K2.7 Code ●) E:\\repos ctrl-o: editor',
      'yolo agent (K2.7 Code ●) E:\\repos jnewline',
      'context: 5.2%',
      'context: 5.3%',
      'context: 5.4%',
      '(13.8k/262.1k)',
      '(14.3k/262.1k)',
      '— input',
      'ctrl-o: editor',
      'jnewline',
      'shift-tab: pan mode',
      'Composing... 31s · 1.2k tokens',
      'Composing... 27s · 1.2k tokens',
    ];
    for (const line of junk) {
      const result = n.process(makeLine(line, 'kimi'));
      if (result !== null) {
        console.log('NOT DROPPED:', JSON.stringify(line), '=>', JSON.stringify(result?.line));
      }
      expect(result).toBeNull();
    }
  });

  it('treats composing labels as live thinking placeholders', () => {
    const n = new TerminalStreamNormalizer();
    const out = n.process(makeLine('Composing...', 'kimi', 't1'));
    expect(out?.line).toBe('Composing...');
    expect(out?.thinkingLive).toBe(true);
  });

  it('drops every junk pattern visible in freshscrenshot.jpg', () => {
    const n = new TerminalStreamNormalizer();
    const junk = [
      'yolo agent (K2.7 Code •) E:\\repos shift-tab: plan mode | ctrl-o: editor',
      'yolo agent (K2.7 Code •) E:\\repos ctrl-v: paste clipboard | @: mention files',
      'yolo agent (K2.7 Code •) E:\\repos ctrl-x: toggle mode',
      'yolo agent (K2.7 Code •) E:\\repos ctrl-j: newline',
      'yolo agent (K2.7 Code •) E:\\repos /feedback: send feedback',
      '— input',
      'ctrl-v: paste clipboard | @: mention files',
      'ctrl-x: toggle mode',
      'ctrl-j: newline',
      '/feedback: send feedback',
      'thme: switch dark/light',
      '/theme: switch dark/light',
      'crl-vpaste clipboard | @: mention files',
      '@: mention files | ctl-x: toggle mode',
      'shift-tab: plan mode',
      'ctrl-o: editor',
      'jnewline | /feedback: send feedback',
    ];
    for (const line of junk) {
      expect(n.process(makeLine(line, 'kimi'))).toBeNull();
    }
  });

  it('drops every junk pattern visible in seewhersresikl.jpg', () => {
    const n = new TerminalStreamNormalizer();
    const junk = [
      '— input · 1 queued',
      '↑ to edit · ctrl-s to send immediately',
      'yolo agent (K2.7 Code •) E:\\repos /feedback: send feedback',
      '(101.9k/262.1k) ⫶ (acp-desktop\\src\\renderer\\...Terminal\\TerminalPane.tsx)',
      'context: 38.5%',
      'context: 3.3% (83',
      'context: 39.% (104.5',
    ];
    for (const line of junk) {
      expect(n.process(makeLine(line, 'kimi'))).toBeNull();
    }
  });

  it('drops every junk pattern visible in isthereanyposbilidyffy.jpg', () => {
    const n = new TerminalStreamNormalizer();
    const junk = [
      'yolo  agent (K2.7 Code •) E:\\repos ctrl-o: editor | ctrl-j: newline',
      'yolo  agent (K2.7 Code •) E:\\repos /feedback: send feedback',
      'yolo   agent (K2.7 Code •) E:\\repos /feedback: send feedback',
      '— input',
      '— input ',
      '________________________',
      '___',
    ];
    for (const line of junk) {
      const result = n.process(makeLine(line, 'kimi'));
      if (result !== null) {
        console.log('NOT DROPPED:', JSON.stringify(line), '=>', JSON.stringify(result?.line));
      }
      expect(result).toBeNull();
    }
  });

  it('drops — input from itsdomcing.jpg', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('— input', 'kimi'))).toBeNull();
  });

  it('drops yolo agent + ctrl-j + /feedback from itsdomcing.jpg', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('yolo agent (K2.7 Code •) E:\\repos ctrl-j: newline | /feedback: send feedback', 'kimi'))).toBeNull();
  });

  it('drops Composing... <1s · 140 tokens from itsdomcing.jpg', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('Composing... <1s · 140 tokens', 'kimi'))).toBeNull();
  });

  it('extracts context usage from footer lines', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('context: 38.5%', 'kimi'));
    expect(useAgentStatusStore.getState().getStatus('Agent').contextUsage).toBe(38.5);
  });

  it('extracts token usage from footer lines', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('(101.9k/262.1k)', 'kimi'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.tokenUsed).toBe(101900);
    expect(status.tokenMax).toBe(262100);
  });

  it('extracts cwd and model from yolo agent banner', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('yolo agent (K2.7 Code •) E:\\repos ctrl-o: editor', 'kimi'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.model).toBe('K2.7 Code');
    expect(status.cwd).toBe('E:\\repos');
  });

  it('extracts composing state from footer lines', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Composing... <1s · 140 tokens', 'kimi'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.composing).toEqual({ duration: '<1s', tokens: 140 });
  });

  it('extracts status even when footer arrives during a thinking block', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Thinking...', 'claude', 't1'));
    n.process(makeLine('context: 55.5%', 'claude', 't1'));
    n.process(makeLine('', 'claude', 't1'));
    n.process(makeLine('Here is the answer', 'claude', 't1'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.contextUsage).toBe(55.5);
  });

  it('extracts cwd and model from multi-space yolo agent banners', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('yolo  agent (K2.7 Code •) E:\\repos ctrl-o: editor', 'kimi'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.model).toBe('K2.7 Code');
    expect(status.cwd).toBe('E:\\repos');
  });

  it('parses token suffixes m and plain numbers', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('(5.5m/8m)', 'kimi'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.tokenUsed).toBe(5_500_000);
    expect(status.tokenMax).toBe(8_000_000);
  });

  it('extracts composing durations in seconds and minutes', () => {
    useAgentStatusStore.getState().clear('Agent');
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Composing... 2m · 5k tokens', 'kimi'));
    const status = useAgentStatusStore.getState().getStatus('Agent');
    expect(status.composing).toEqual({ duration: '2m', tokens: 5000 });
  });
});
