import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { UnifiedTerminal } from './UnifiedTerminal';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAppStore } from '../../stores/appStore';
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

  it('renders live thinking as a single faded block', () => {
    useAppStore.setState({ settings: { showThinking: true } as any });
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert', terminal_id: 't1', line: 'Thinking...', thinking: 'step one', thinkingLive: true, ts: new Date().toISOString() },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    expect(container.querySelector('[data-testid="thinking-live"]')).not.toBeNull();
    expect(container.textContent).toContain('Thinking...');
    cleanup(root, container);
  });

  it('updates the live thinking block in place rather than appending a new line', () => {
    useAppStore.setState({ settings: { showThinking: true } as any });
    const t1 = new Date().toISOString();
    useAgentOutputStore.setState({
      lines: [
        { agent: 'NextPert', terminal_id: 't1', line: 'Thinking...', thinking: 'step one', thinkingLive: true, ts: t1 },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);

    act(() => {
      useAgentOutputStore.setState({
        lines: [
          { agent: 'NextPert', terminal_id: 't1', line: 'Analyzing...', thinking: 'step one\nstep two', thinkingLive: true, ts: new Date().toISOString() },
        ],
      });
    });

    const liveBlocks = container.querySelectorAll('[data-testid="thinking-live"]');
    expect(liveBlocks.length).toBe(1);
    expect(container.textContent).toContain('Analyzing...');
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
});
