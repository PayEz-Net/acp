import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { UnifiedTerminal } from './UnifiedTerminal';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import type { AgentState } from '@shared/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockWriteTerminal = vi.fn();
const mockResizeTerminal = vi.fn();
const mockReadClipboardText = vi.fn();

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal('electronAPI', {
    writeTerminal: mockWriteTerminal,
    resizeTerminal: mockResizeTerminal,
    readClipboardText: mockReadClipboardText,
  });
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  useAgentOutputStore.setState({ lines: [] });
  useAgentStatusStore.setState({ statuses: {} });
  useProjectStore.setState({ activeProject: null, currentProjectTeam: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function cleanup(root: Root, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
}

function setMeasuredSizes(host: HTMLElement, measure: HTMLElement) {
  // Sample chars = 'MMMMMMMMMM' (10 chars). Bounding width = 120 => charWidth = 12.
  Object.defineProperty(measure, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 120, height: 24, x: 0, y: 0, top: 0, left: 0, bottom: 24, right: 120, toJSON: () => ({}) }),
  });
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 600 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: () => ({ paddingLeft: '8px', paddingRight: '8px', paddingTop: '8px', paddingBottom: '8px' }),
  });
}

describe('UnifiedTerminal', () => {
  it('renders placeholder when no terminal id and no output', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" />);
    expect(container.textContent).toContain('Terminal output will appear here.');
    cleanup(root, container);
  });

  it('renders only lines for the target agent', () => {
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert', terminal_id: 't1', line: 'hello', ts: new Date().toISOString() },
        { agent: 'BAPert', terminal_id: 't2', line: 'world', ts: new Date().toISOString() },
        { agent: 'NextPert', terminal_id: 't1', line: 'again', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('again');
    expect(container.textContent).not.toContain('world');
    cleanup(root, container);
  });

  it('surfaces live thinking as a single-line footer indicator instead of stream blocks', () => {
    useAppStore.setState({ settings: { showThinking: true } as any });
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert', terminal_id: 't1', line: 'Thinking...', thinking: 'step one', thinkingLive: true, ts: new Date().toISOString() },
      ],
    });

    const agent: AgentState = {
      id: '1',
      name: 'NextPert',
      displayName: 'NextPert',
      workDir: '',
      autoStart: false,
      position: 'top-left',
      status: 'busy',
      provider: 'kimi',
    };

    const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
    // Live placeholders do not stack inside the scroll surface.
    expect(container.querySelector('[data-testid="thinking-live"]')).toBeNull();
    expect(container.querySelector('[data-testid="thinking-block"]')).toBeNull();
    // The footer shows the compact Thinking… status pill.
    expect(container.textContent).toContain('Thinking…');
    cleanup(root, container);
  });

  it('keeps the footer thinking indicator current as live thinking updates', () => {
    useAppStore.setState({ settings: { showThinking: true } as any });
    const t1 = new Date().toISOString();
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert', terminal_id: 't1', line: 'Thinking...', thinking: 'step one', thinkingLive: true, ts: t1 },
      ],
    });

    const agent: AgentState = {
      id: '1',
      name: 'NextPert',
      displayName: 'NextPert',
      workDir: '',
      autoStart: false,
      position: 'top-left',
      status: 'busy',
      provider: 'kimi',
    };

    const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
    expect(container.textContent).toContain('Thinking…');

    act(() => {
      useAgentOutputStore.setState({
        lines: [
          { agent: 'NextPert', terminal_id: 't1', line: 'Here is the answer', thinking: 'step one\nstep two', thinkingLive: false, ts: new Date().toISOString() },
        ],
      });
    });

    // Footer drops the live indicator; stream now shows the finalized answer.
    expect(container.textContent).toContain('Here is the answer');
    expect(container.textContent).toContain('Busy');
    cleanup(root, container);
  });

  it('surface has role="log", aria-live="polite", and tabIndex="0"', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" />);
    const surface = container.querySelector('[role="log"]');
    expect(surface).not.toBeNull();
    expect(surface?.getAttribute('aria-live')).toBe('polite');
    expect(surface?.getAttribute('tabIndex')).toBe('0');
    cleanup(root, container);
  });

  it('forwards printable keystrokes to writeTerminal', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const surface = container.querySelector('[role="log"]') as HTMLDivElement;

    act(() => {
      surface.focus();
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });

    expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'a');
    cleanup(root, container);
  });

  it('sends SIGINT when Ctrl+C is pressed with no selection', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const surface = container.querySelector('[role="log"]') as HTMLDivElement;

    act(() => {
      surface.focus();
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    });

    expect(mockWriteTerminal).toHaveBeenCalledWith('t1', '\u0003');
    cleanup(root, container);
  });

  it('does not send SIGINT when Ctrl+C is pressed with a selection', () => {
    // Stub getSelection so toString returns non-empty text.
    vi.stubGlobal('getSelection', () => ({
      toString: () => 'selected text',
      rangeCount: 1,
      removeAllRanges: () => {},
    }));

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const surface = container.querySelector('[role="log"]') as HTMLDivElement;

    act(() => {
      surface.focus();
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    });

    expect(mockWriteTerminal).not.toHaveBeenCalledWith('t1', '\u0003');
    cleanup(root, container);
  });

  it('pastes clipboard text when Ctrl+V is pressed', async () => {
    mockReadClipboardText.mockResolvedValue('pasted content');
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const surface = container.querySelector('[role="log"]') as HTMLDivElement;

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockReadClipboardText).toHaveBeenCalled();
    expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'pasted content');
    cleanup(root, container);
  });

  it('calls resizeTerminal with cols >= MIN_COLS and rows >= MIN_ROWS', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const host = container.querySelector('[data-testid="terminal-host"]') as HTMLElement;
    const measure = container.querySelector('[data-testid="terminal-measure"]') as HTMLElement;
    setMeasuredSizes(host, measure);

    act(() => {
      // Trigger the ResizeObserver callback and rAF chain by re-rendering.
      host.dispatchEvent(new Event('resize'));
    });

    expect(mockResizeTerminal).toHaveBeenCalled();
    const [, cols, rows] = mockResizeTerminal.mock.lastCall ?? ['', 0, 0];
    expect(cols).toBeGreaterThanOrEqual(10);
    expect(rows).toBeGreaterThanOrEqual(4);

    cleanup(root, container);
  });

  describe('composer input', () => {
    it('renders the Vercel-style composer input', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      expect(input).not.toBeNull();
      cleanup(root, container);
    });

    it('disables the composer when there is no terminal session', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      expect(input.disabled).toBe(true);
      cleanup(root, container);
    });

    it('sends the typed line + newline on Enter', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.value = 'npm test';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'npm test\r');
      expect(input.value).toBe('');
      cleanup(root, container);
    });

    it('sends Escape to the PTY from the composer', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', '\u001b');
      cleanup(root, container);
    });

    it('sends Tab to the PTY from the composer', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', '\t');
      cleanup(root, container);
    });

    it('sends SIGINT from the composer when Ctrl+C is pressed with no selection', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.value = 'partial command';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', '\u0003');
      expect(input.value).toBe('');
      cleanup(root, container);
    });

    it('pastes clipboard text into the composer when Ctrl+V is pressed', async () => {
      mockReadClipboardText.mockResolvedValue('pasted content');
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(mockReadClipboardText).toHaveBeenCalled();
      expect(input.value).toBe('pasted content');
      cleanup(root, container);
    });

    it('sends the input line when the send button is clicked', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const sendBtn = container.querySelector('[data-testid="terminal-send"]') as HTMLButtonElement;

      act(() => {
        input.value = 'build now';
        sendBtn.click();
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'build now\r');
      expect(input.value).toBe('');
      cleanup(root, container);
    });
  });

  it('renders parsed agent status in the footer', () => {
    useAgentStatusStore.getState().setStatus('NextPert', {
      contextUsage: 42,
      model: 'K2.7 Code',
      cwd: 'E:\\repos\\acp-desktop',
      composing: { duration: '<1s', tokens: 140 },
    });

    const agent: AgentState = {
      id: '1',
      name: 'NextPert',
      displayName: 'NextPert',
      workDir: '',
      autoStart: false,
      position: 'top-left',
      status: 'busy',
      provider: 'kimi',
    };

    const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
    expect(container.querySelector('[title="Context usage: 42%"]')).not.toBeNull();
    expect(container.textContent).toContain('K2.7 Code');
    expect(container.textContent).toContain('<1s · 140t');
    cleanup(root, container);
  });

  it('uses activeProject.runtime_choice as the provider authority in the footer', () => {
    useProjectStore.setState({
      activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
    });
    const agent: AgentState = {
      id: '1',
      name: 'NextPert',
      displayName: 'NextPert',
      workDir: '',
      autoStart: false,
      position: 'top-left',
      status: 'busy',
      provider: 'claude',
    };

    const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
    expect(container.textContent).toContain('kimi');
    expect(container.textContent).not.toContain('claude');
    cleanup(root, container);
  });

  it('renders code-change blocks as structured cards', () => {
    useAgentOutputStore.setState({
      lines: [
        {
          agent: 'NextPert',
          terminal_id: 't1',
          line: 'Modified: App.tsx',
          ts: new Date().toISOString(),
          codeChange: {
            filePath: 'App.tsx',
            operation: 'modified',
            hunks: [
              {
                lines: [
                  { type: 'context', text: 'const x = 1;', lineNumber: 10 },
                  { type: 'add', text: 'const y = 2;', lineNumber: 11 },
                  { type: 'remove', text: 'const z = 3;', lineNumber: 12 },
                ],
              },
            ],
          },
        },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    expect(container.textContent).toContain('App.tsx');
    expect(container.textContent).toContain('modified');
    expect(container.textContent).toContain('const y = 2');
    expect(container.textContent).toContain('const z = 3');
    cleanup(root, container);
  });

  it('does not affect normal chat lines when code-change cards are present', () => {
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert', terminal_id: 't1', line: 'Hello world', ts: new Date().toISOString() },
        {
          agent: 'NextPert',
          terminal_id: 't1',
          line: 'Modified: App.tsx',
          ts: new Date().toISOString(),
          codeChange: {
            filePath: 'App.tsx',
            operation: 'modified',
            hunks: [{ lines: [{ type: 'add', text: 'const x = 1;' }] }],
          },
        },
        { agent: 'NextPert', terminal_id: 't1', line: 'Done', ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    expect(container.textContent).toContain('Hello world');
    expect(container.textContent).toContain('Done');
    expect(container.textContent).toContain('modified');
    expect(container.textContent).toContain('App.tsx');
    cleanup(root, container);
  });

  it('collapses large code-change diffs by default and expands on click', () => {
    const manyLines = Array.from({ length: 25 }, (_, i) => ({
      type: 'add' as const,
      text: `const line${i} = ${i};`,
    }));
    useAgentOutputStore.setState({
      lines: [
        {
          agent: 'NextPert',
          terminal_id: 't1',
          line: 'Modified: Big.tsx',
          ts: new Date().toISOString(),
          codeChange: {
            filePath: 'Big.tsx',
            operation: 'modified',
            hunks: [{ lines: manyLines }],
          },
        },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    expect(container.textContent).toContain('const line0 = 0');
    expect(container.textContent).toContain('const line9 = 9');
    expect(container.textContent).not.toContain('const line19 = 19');
    expect(container.textContent).toContain('Show 15 more lines');

    const expandButton = container.querySelector('button');
    expect(expandButton).not.toBeNull();
    act(() => {
      expandButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('const line19 = 19');
    expect(container.textContent).toContain('Show less');
    cleanup(root, container);
  });
});
