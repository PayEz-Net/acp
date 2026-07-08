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

  it('drops blank and whitespace-only lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine(''))).toBeNull();
    expect(n.process(makeLine(''))).toBeNull();
    expect(n.process(makeLine('   '))).toBeNull();
    expect(n.process(makeLine('\t'))).toBeNull();
    // A non-blank line still emits normally.
    expect(n.process(makeLine('A'))?.line).toBe('A');
    // Blanks after content are still dropped.
    expect(n.process(makeLine(''))).toBeNull();
    expect(n.process(makeLine('   '))).toBeNull();
  });

  it('drops blank lines even when interleaved with suppressed noise lines', () => {
    const n = new TerminalStreamNormalizer();
    // Real content, then alternating blank / footer / blank / footer should emit
    // no blank lines because blanks are dropped entirely.
    expect(n.process(makeLine('A'))?.line).toBe('A');
    expect(n.process(makeLine(''))).toBeNull();
    expect(n.process(makeLine('context: 69.4%'))).toBeNull(); // footer suppressed
    expect(n.process(makeLine(''))).toBeNull();
    expect(n.process(makeLine('context: 70.1%'))).toBeNull(); // footer suppressed
    expect(n.process(makeLine(''))).toBeNull();
    expect(n.process(makeLine('B'))?.line).toBe('B');
  });

  it('suppresses identical lines that reappear within the dedup window', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:01.000Z').toISOString();
    const t2 = new Date('2026-07-03T12:00:02.000Z').toISOString();
    expect(n.process(makeLine('A', 'claude', 't1', t0))?.line).toBe('A');
    expect(n.process(makeLine('B', 'claude', 't1', t1))?.line).toBe('B');
    // A reappears within 5 s even though B came in between — should be suppressed.
    expect(n.process(makeLine('A', 'claude', 't1', t2))).toBeNull();
  });

  it('allows identical lines after the dedup window expires', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:06.000Z').toISOString();
    expect(n.process(makeLine('A', 'claude', 't1', t0))?.line).toBe('A');
    expect(n.process(makeLine('A', 'claude', 't1', t1))?.line).toBe('A');
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

  it('drops the exact Kimi status line seen in the screenshot', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('context: 63.5% (166.5k/262.1k) 302t', 'kimi'))).toBeNull();
  });

  it('drops Kimi cheap-spinner numeric artifacts as footer noise', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine(':275347', 'kimi'))).toBeNull();
    expect(n.process(makeLine('302t', 'kimi'))).toBeNull();
    expect(n.process(makeLine('262.1k) 302t', 'kimi'))).toBeNull();
    // Plain numbers without status markers must not be dropped.
    expect(n.process(makeLine('42', 'kimi'))?.line).toBe('42');
  });

  it('drops residual ANSI/TUI chud artifacts that survive stripping', () => {
    const n = new TerminalStreamNormalizer();
    // Time-like cursor-position fragments and status counters.
    expect(n.process(makeLine(':37', 'kimi'))).toBeNull();
    expect(n.process(makeLine('2:12', 'kimi'))).toBeNull();
    expect(n.process(makeLine('21:12', 'kimi'))).toBeNull();
    expect(n.process(makeLine(':.8 info:', 'kimi'))).toBeNull();
    expect(n.process(makeLine(':0.8 info: working', 'kimi'))).toBeNull();
    // Orphaned SGR fragments at line start are removed before classification.
    expect(n.process(makeLine('[3 Real output line', 'kimi'))?.line).toBe('Real output line');
    expect(n.process(makeLine('[37mcolored text', 'kimi'))?.line).toBe('colored text');
    // Colon-prefixed numeric fragments are stripped so real content emerges.
    expect(n.process(makeLine(':32Actually, the simplest...', 'kimi'))?.line).toBe('Actually, the simplest...');
    expect(n.process(makeLine(':47 a postgres pod in AKS', 'kimi'))?.line).toBe('a postgres pod in AKS');
    expect(n.process(makeLine(':.6 to fix the 500 errors', 'kimi'))?.line).toBe('to fix the 500 errors');
    expect(n.process(makeLine(':0.55 or if I can run', 'kimi'))?.line).toBe('or if I can run');
    // Standalone numeric artifacts (cursor coordinates / line numbers) do not end
    // a thinking block, so they don't fracture it into one-line noise stacks.
    const n2 = new TerminalStreamNormalizer();
    n2.process(makeLine('Thinking...', 'kimi', 't2'));
    n2.process(makeLine('step one', 'kimi', 't2'));
    n2.process(makeLine('', 'kimi', 't2'));
    const artifact1 = n2.process(makeLine('78', 'kimi', 't2'));
    expect(artifact1?.thinkingLive).toBe(true);
    n2.process(makeLine('', 'kimi', 't2'));
    const artifact2 = n2.process(makeLine('50:', 'kimi', 't2'));
    expect(artifact2?.thinkingLive).toBe(true);
    n2.process(makeLine('', 'kimi', 't2'));
    // Colon-prefixed decimals are absorbed as footer noise and do not fracture.
    const artifact3 = n2.process(makeLine(':.6', 'kimi', 't2'));
    expect(artifact3?.thinkingLive).toBe(true);
    const answer = n2.process(makeLine('Here is the answer', 'kimi', 't2'));
    expect(answer?.line).toBe('Here is the answer');
    expect(answer?.thinking).toContain('78');
    expect(answer?.thinking).toContain('50:');
    // Real content that happens to contain colons must still emit.
    expect(n.process(makeLine('See issue #2: fix the bug', 'kimi'))?.line).toBe('See issue #2: fix the bug');
  });

  it('normalizes Kimi unordered-list bullets to •', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('- First item', 'kimi'))?.line).toBe('• First item');
    expect(n.process(makeLine('* Second item', 'kimi'))?.line).toBe('• Second item');
    expect(n.process(makeLine('  - Nested item', 'kimi'))?.line).toBe('  • Nested item');
    expect(n.process(makeLine('1. Ordered item', 'kimi'))?.line).toBe('1. Ordered item');
    // Dashes in prose must not be altered.
    expect(n.process(makeLine('This is - not a list', 'kimi'))?.line).toBe('This is - not a list');
  });

  it('drops split footer continuation fragments within the continuation window', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:00.100Z').toISOString();
    const t2 = new Date('2026-07-03T12:00:00.200Z').toISOString();
    const t3 = new Date('2026-07-03T12:00:00.300Z').toISOString();
    // Full footer is dropped as before.
    expect(n.process(makeLine('context: 63.5% (166.5k/262.1k)', 'kimi', 't1', t0))).toBeNull();
    // Trailing fragment that leaks on its own is dropped because it arrives soon after the footer.
    expect(n.process(makeLine('302t', 'kimi', 't1', t1))).toBeNull();
    // A second fragment is also dropped and extends the window.
    expect(n.process(makeLine('262.1k) 302t', 'kimi', 't1', t2))).toBeNull();
    // Real content still reaches the stream.
    expect(n.process(makeLine('Here is the answer', 'kimi', 't1', t3))?.line).toBe('Here is the answer');
  });

  it('does not suppress footer-looking fragments outside the continuation window', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:01.000Z').toISOString();
    expect(n.process(makeLine('context: 63.5%', 'kimi', 't1', t0))).toBeNull();
    // A bare token ratio is only treated as a footer fragment within the window.
    expect(n.process(makeLine('166.5k/262.1k', 'kimi', 't1', t1))?.line).toBe('166.5k/262.1k');
  });

  it('drops em-dash input prompts entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('— input'))).toBeNull();
    expect(n.process(makeLine('— input'))).toBeNull();
  });

  it('drops box-drawing and hyphen input prompts entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('─ input'))).toBeNull();
    expect(n.process(makeLine('━ input'))).toBeNull();
    expect(n.process(makeLine('- input'))).toBeNull();
    expect(n.process(makeLine('─── input'))).toBeNull();
    expect(n.process(makeLine('━━━ input'))).toBeNull();
  });

  it('does not regress multi-dash or equals input prompt suppression', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('--- input'))).toBeNull();
    expect(n.process(makeLine('-- input'))).toBeNull();
    expect(n.process(makeLine('== input'))).toBeNull();
  });

  it('does not drop prose starting with a hyphen or dash', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('- item one'))?.line).toBe('- item one');
    expect(n.process(makeLine('--flag value'))?.line).toBe('--flag value');
    expect(n.process(makeLine('─ item one'))?.line).toBe('─ item one');
  });

  it('drops box-drawing horizontal separator lines entirely', () => {
    const n = new TerminalStreamNormalizer();
    expect(n.process(makeLine('───'))).toBeNull();
    expect(n.process(makeLine('━━━'))).toBeNull();
    expect(n.process(makeLine('─━─'))).toBeNull();
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

  it('detects a code-change block with file path and operation', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date('2026-07-03T12:00:00.000Z').toISOString();
    const t1 = new Date('2026-07-03T12:00:01.000Z').toISOString();
    const t2 = new Date('2026-07-03T12:00:02.000Z').toISOString();
    const t3 = new Date('2026-07-03T12:00:03.000Z').toISOString();

    expect(n.process(makeLine('Now modify TerminalPane.tsx...', 'claude', 't1', t0))).toBeNull();
    const diff1 = n.process(makeLine('| 71 const isThinkingLive = true;', 'claude', 't1', t1));
    expect(diff1?.codeChange).toBeUndefined();
    const diff2 = n.process(makeLine('| 483 +provider={effectiveProvider}', 'claude', 't1', t2));
    expect(diff2?.codeChange).toBeUndefined();
    const tool = n.process(makeLine('Using StrReplaceFile', 'claude', 't1', t3));
    expect(tool?.codeChange).toBeDefined();
    expect(tool?.line).toBe('Modified: TerminalPane.tsx');
    expect(tool?.codeChange?.filePath).toBe('TerminalPane.tsx');
    expect(tool?.codeChange?.operation).toBe('modified');
    expect(tool?.codeChange?.hunks[0].lines).toHaveLength(2);
    expect(tool?.codeChange?.hunks[0].lines[0]).toEqual({ type: 'context', text: 'const isThinkingLive = true;', lineNumber: 71 });
    expect(tool?.codeChange?.hunks[0].lines[1]).toEqual({ type: 'add', text: 'provider={effectiveProvider}', lineNumber: 483 });
  });

  it('detects created and deleted code-change operations', () => {
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Creating src/main/foo.ts', 'claude', 't1'));
    n.process(makeLine('+ export const foo = 1;', 'claude', 't1'));
    const created = n.process(makeLine('Using WriteFile', 'claude', 't1'));
    expect(created?.codeChange?.operation).toBe('created');
    expect(created?.codeChange?.filePath).toBe('src/main/foo.ts');

    const n2 = new TerminalStreamNormalizer();
    n2.process(makeLine('Delete src/main/old.ts', 'claude', 't2'));
    n2.process(makeLine('- export const old = 1;', 'claude', 't2'));
    const deleted = n2.process(makeLine('Using StrReplaceFile', 'claude', 't2'));
    expect(deleted?.codeChange?.operation).toBe('deleted');
    expect(deleted?.codeChange?.filePath).toBe('src/main/old.ts');
  });

  it('does not misclassify normal prose as code-change blocks', () => {
    const n = new TerminalStreamNormalizer();
    const out = n.process(makeLine('Here is a + sign in prose.', 'claude', 't1'));
    expect(out?.codeChange).toBeUndefined();
    expect(out?.line).toBe('Here is a + sign in prose.');
  });

  it('defers the line that ends a code-change block', () => {
    const n = new TerminalStreamNormalizer();
    n.process(makeLine('Now modify App.tsx', 'claude', 't1'));
    n.process(makeLine('+ const x = 1;', 'claude', 't1'));
    const card = n.process(makeLine('Next, review the output.', 'claude', 't1'));
    expect(card?.codeChange).toBeDefined();
    expect(card?.line).toBe('Modified: App.tsx');
    const deferred = n.drain();
    expect(deferred?.line).toBe('Next, review the output.');
  });

  it('tags echoed user input as user-source and removes it from the match buffer', () => {
    const n = new TerminalStreamNormalizer();
    const ts = new Date().toISOString();
    n.recordUserInput('t1', 'hello world', new Date(ts).getTime());
    const out = n.process(makeLine('hello world', 'claude', 't1', ts));
    expect(out?.source).toBe('user');
    // A different line after the consumed input should be agent-source.
    const out2 = n.process(makeLine('agent reply', 'claude', 't1', ts));
    expect(out2?.source).toBe('agent');
  });

  it('suppresses delayed repeats of user input even after the match buffer expires', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date().toISOString();
    const t0ms = new Date(t0).getTime();
    n.recordUserInput('t1', 'mail BAPert', t0ms);

    // First echo arrives quickly and is emitted as user-source.
    const first = n.process(makeLine('mail BAPert', 'claude', 't1', t0));
    expect(first?.source).toBe('user');

    // A delayed provider redraw arrives after the 2s match buffer but within
    // the 30s user-input dedup window; it should be suppressed entirely.
    const delayed = n.process(
      makeLine('mail BAPert', 'claude', 't1', new Date(t0ms + 5000).toISOString()),
    );
    expect(delayed).toBeNull();
  });

  it('recognizes echoed user input with a prompt prefix as user-source', () => {
    const n = new TerminalStreamNormalizer();
    const ts = new Date().toISOString();
    n.recordUserInput('t1', 'mail BAPert', new Date(ts).getTime());

    // Provider CLI echoes the input with a leading "> " prompt.
    const out = n.process(makeLine('> mail BAPert', 'claude', 't1', ts));
    expect(out?.source).toBe('user');
    expect(out?.line).toBe('> mail BAPert');

    // A later identical prefixed echo is suppressed as a repeat.
    const repeat = n.process(
      makeLine('> mail BAPert', 'claude', 't1', new Date(new Date(ts).getTime() + 5000).toISOString()),
    );
    expect(repeat).toBeNull();
  });

  it('does not suppress unrelated agent output that happens to match old user input', () => {
    const n = new TerminalStreamNormalizer();
    const t0 = new Date().toISOString();
    const t0ms = new Date(t0).getTime();
    n.recordUserInput('t1', 'mail BAPert', t0ms);
    n.process(makeLine('mail BAPert', 'claude', 't1', t0));

    // After the user-input dedup window, the agent legitimately echoes the text.
    const later = n.process(
      makeLine('mail BAPert', 'claude', 't1', new Date(t0ms + 31000).toISOString()),
    );
    expect(later?.source).toBe('agent');
  });

  it('classifies ACP mail and failure notices as info-source', () => {
    const n = new TerminalStreamNormalizer();
    const mail = n.process(makeLine('[ACP mail] new message from QAPert', 'claude', 't1'));
    expect(mail?.source).toBe('info');
    const fail = n.process(makeLine('Failed to start: backend unavailable', 'claude', 't1'));
    expect(fail?.source).toBe('info');
    const prose = n.process(makeLine('Here is the answer.', 'claude', 't1'));
    expect(prose?.source).toBe('agent');
  });

});
