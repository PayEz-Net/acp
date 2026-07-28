import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { UnifiedTerminal, encodeImageForTransport } from './UnifiedTerminal';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import { clearTelemetryQueue } from '../../lib/telemetry';
import type { AgentState } from '@shared/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockWriteTerminal = vi.fn();
const mockResizeTerminal = vi.fn();
const mockReadClipboardText = vi.fn();
const mockTriggerPaste = vi.fn();

const mockSendAcpPrompt = vi.fn().mockResolvedValue(undefined);
const mockSendAcpCancel = vi.fn().mockResolvedValue(undefined);
const mockPurgeAcpQueue = vi.fn().mockResolvedValue(0);
const mockSendAcpPermissionResponse = vi.fn().mockResolvedValue(undefined);

class ResizeObserverMock {
  private callback: ResizeObserverCallback | null = null;
  observe = vi.fn((target: Element) => {
    // Provide a non-zero size so dimension math and virtualization initialize.
    if (this.callback) {
      this.callback(
        [
          {
            target,
            contentRect: { width: 600, height: 300, top: 0, left: 0, bottom: 300, right: 600, x: 0, y: 0 },
            borderBoxSize: [{ inlineSize: 600, blockSize: 300 }],
            contentBoxSize: [{ inlineSize: 600, blockSize: 300 }],
            devicePixelContentBoxSize: [{ inlineSize: 600, blockSize: 300 }],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
  });
  disconnect = vi.fn();
  unobserve = vi.fn();
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
}

beforeEach(() => {
  vi.stubGlobal('electronAPI', {
    writeTerminal: mockWriteTerminal,
    resizeTerminal: mockResizeTerminal,
    readClipboardText: mockReadClipboardText,
    triggerPaste: mockTriggerPaste,
    sendAcpPrompt: mockSendAcpPrompt,
    sendAcpCancel: mockSendAcpCancel,
    purgeAcpQueue: mockPurgeAcpQueue,
    sendAcpPermissionResponse: mockSendAcpPermissionResponse,
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
  useAcpSessionStore.setState({ sessions: new Map() });
  useAppStore.setState({ settings: {} as any });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clearTelemetryQueue();
});

function pasteFilesOnInput(input: HTMLInputElement, files: File[], text?: string) {
  // jsdom's DataTransfer only reliably supports one file item and ignores
  // overrides of the .files getter, so we use a fully mocked clipboardData
  // object that exposes both items and files consistently.
  const fileList = Object.setPrototypeOf(
    {
      length: files.length,
      item: (index: number) => files[index] ?? null,
      [Symbol.iterator]: function* () {
        for (let i = 0; i < files.length; i++) {
          yield files[i];
        }
      },
    },
    FileList.prototype,
  ) as FileList;

  const items: DataTransferItem[] = files.map(
    (file) =>
      ({
        kind: 'file',
        type: file.type,
        getAsFile: () => file,
        getAsString: () => {},
      }) as unknown as DataTransferItem,
  );
  if (text != null) {
    items.push({
      kind: 'string',
      type: 'text/plain',
      getAsFile: () => null as unknown as File,
      getAsString: (callback: (s: string) => void) => callback(text),
    } as unknown as DataTransferItem);
  }

  const clipboardData = {
    items,
    files: fileList,
    getData: (type: string) => (type === 'text/plain' && text != null ? text : ''),
    setData: () => {},
  };

  const event = new Event('paste', { bubbles: true });
  Object.defineProperty(event, 'clipboardData', {
    value: clipboardData,
    configurable: true,
  });
  input.dispatchEvent(event);
}

function pasteTextOnInput(input: HTMLInputElement, text: string, items: DataTransferItem[] = []) {
  // Simulates clipboard sources that expose plain text only via getData and
  // leave clipboardData.items empty.
  const emptyFileList = Object.setPrototypeOf(
    {
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    },
    FileList.prototype,
  ) as FileList;

  const clipboardData = {
    items,
    files: emptyFileList,
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    setData: () => {},
  };

  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: clipboardData,
    configurable: true,
  });
  input.dispatchEvent(event);
}

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

function setMeasuredSizes(host: HTMLElement, measure: HTMLElement, scroll?: HTMLElement) {
  // Sample chars = 'MMMMMMMMMM' (10 chars). Bounding width = 120 => charWidth = 12.
  const measureRect = { width: 120, height: 24, x: 0, y: 0, top: 0, left: 0, bottom: 24, right: 120, toJSON: () => ({}) };
  Object.defineProperty(measure, 'getBoundingClientRect', {
    configurable: true,
    value: () => measureRect,
  });
  Object.defineProperty(host, 'clientWidth', { configurable: true, value: 600 });
  Object.defineProperty(host, 'clientHeight', { configurable: true, value: 300 });
  Object.defineProperty(host, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 600, height: 300, x: 0, y: 0, top: 0, left: 0, bottom: 300, right: 600, toJSON: () => ({}) }),
  });
  // The dimension math now measures the scroll surface, not the host.
  const target = scroll ?? host;
  Object.defineProperty(target, 'clientWidth', { configurable: true, value: 584 }); // 600 - 16px padding
  Object.defineProperty(target, 'clientHeight', { configurable: true, value: 284 }); // 300 - 16px padding
  Object.defineProperty(target, 'scrollHeight', { configurable: true, value: 10000 });
  let currentScrollTop = 0;
  Object.defineProperty(target, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value) => {
      currentScrollTop = value;
    },
  });
  Object.defineProperty(target, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 584, height: 284, x: 0, y: 0, top: 0, left: 0, bottom: 284, right: 584, toJSON: () => ({}) }),
  });
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
        { id: 'np-1', agent: 'NextPert', terminal_id: 't1', line: 'hello', ts: new Date().toISOString() },
        { id: 'ba-1', agent: 'BAPert', terminal_id: 't2', line: 'world', ts: new Date().toISOString() },
        { id: 'np-2', agent: 'NextPert', terminal_id: 't1', line: 'again', ts: new Date().toISOString() },
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
        { id: 'np-thinking-1', agent: 'NextPert', terminal_id: 't1', line: 'Thinking...', thinking: 'step one', thinkingLive: true, ts: new Date().toISOString() },
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
    cleanup(root, container);
  });

  it('keeps the stream free of live-thinking placeholders as thinking updates', async () => {
    useAppStore.setState({ settings: { showThinking: true } as any });
    const t1 = new Date().toISOString();
    useAgentOutputStore.setState({
      lines: [
        { id: 'np-thinking-2', agent: 'NextPert', terminal_id: 't1', line: 'Thinking...', thinking: 'step one', thinkingLive: true, ts: t1 },
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

    act(() => {
      useAgentOutputStore.setState({
        lines: [
          { id: 'np-answer-1', agent: 'NextPert', terminal_id: 't1', line: 'Here is the answer', thinking: 'step one\nstep two', thinkingLive: false, ts: new Date().toISOString() },
        ],
      });
    });

    // Stream now shows the finalized answer instead of a live placeholder.
    expect(container.textContent).toContain('Here is the answer');
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
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const surface = container.querySelector('[role="log"]') as HTMLDivElement;

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'pasted content');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      configurable: true,
      value: dataTransfer,
    });

    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'pasted content');
    cleanup(root, container);
  });

  it('uses native paste for plain text and avoids the main-process clipboard round-trip', async () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const surface = container.querySelector('[role="log"]') as HTMLDivElement;

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', 'quick paste');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      configurable: true,
      value: dataTransfer,
    });

    const start = performance.now();
    await act(async () => {
      surface.focus();
      surface.dispatchEvent(pasteEvent);
      await new Promise((r) => setTimeout(r, 10));
    });
    const duration = performance.now() - start;

    expect(mockReadClipboardText).not.toHaveBeenCalled();
    expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'quick paste');
    expect(duration).toBeLessThan(100);
    cleanup(root, container);
  });

  it('calls resizeTerminal with cols >= MIN_COLS and rows >= MIN_ROWS', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const host = container.querySelector('[data-testid="terminal-host"]') as HTMLElement;
    const measure = container.querySelector('[data-testid="terminal-measure"]') as HTMLElement;
    const scroll = container.querySelector('[role="log"]') as HTMLElement;
    setMeasuredSizes(host, measure, scroll);

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

    it('recalls previous input with Up arrow and restores draft with Down arrow', () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.value = 'first command';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      act(() => {
        input.value = 'second command';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      act(() => {
        input.value = 'draft';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      });
      expect(input.value).toBe('second command');

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      });
      expect(input.value).toBe('first command');

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      expect(input.value).toBe('second command');

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      });
      expect(input.value).toBe('draft');

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

    it('pastes text into the composer via the native paste event', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [], 'pasted content');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('pasted content');
      cleanup(root, container);
    });

    it('falls back to getData when clipboardData.items has no text entry', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'fallback text');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('fallback text');
      cleanup(root, container);
    });

    it('collapses a large multi-line paste into a placeholder', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const largeText = 'line1\nline2\nline3\nline4\nline5\nline6';

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, largeText);
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('[pasted code 6 lines]');
      cleanup(root, container);
    });

    it('collapses a very long single-line paste into a placeholder', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const longText = 'x'.repeat(1001);

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, longText);
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('[pasted code 1 lines]');
      cleanup(root, container);
    });

    it('sends the full text when a collapsed paste placeholder is submitted', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const largeText = 'a\nb\nc\nd\ne\nf';

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, largeText);
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('[pasted code 6 lines]');

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', `${largeText}\r`);
      expect(input.value).toBe('');
      cleanup(root, container);
    });

    it('removes a collapsed paste with Escape and keeps typed text', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        input.value = 'explain this ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('explain this [pasted code 6 lines]');

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(input.value).toBe('explain this ');
      cleanup(root, container);
    });

    it('removes a collapsed paste with Backspace at the boundary and keeps text after it', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const placeholder = '[pasted code 6 lines]';

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe(placeholder);

      act(() => {
        input.value = `${placeholder}explain`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.setSelectionRange(placeholder.length, placeholder.length);
      });

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      });

      expect(input.value).toBe('explain');
      cleanup(root, container);
    });

    it('preserves existing typed text when a large paste is collapsed', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        input.value = 'explain this ';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('explain this [pasted code 6 lines]');
      cleanup(root, container);
    });

    it('keeps text typed after a collapsed paste', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      act(() => {
        input.value = '[pasted code 6 lines] explain';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      expect(input.value).toBe('[pasted code 6 lines] explain');
      cleanup(root, container);
    });

    it('keeps text typed before a collapsed paste', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      act(() => {
        input.value = 'explain [pasted code 6 lines]';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      expect(input.value).toBe('explain [pasted code 6 lines]');
      cleanup(root, container);
    });

    it('sends the combined prompt and full paste on Enter', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const largeText = 'a\nb\nc\nd\ne\nf';

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, largeText);
        await new Promise((r) => setTimeout(r, 10));
      });

      act(() => {
        input.value = `[pasted code 6 lines]explain this`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', `explain this\n\n${largeText}\r`);
      expect(input.value).toBe('');
      cleanup(root, container);
    });

    it('discards the collapsed paste when the placeholder is edited', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      act(() => {
        input.value = '[pasted code 6x lines]';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockWriteTerminal).toHaveBeenCalledWith('t1', '[pasted code 6x lines]\r');
      cleanup(root, container);
    });

    it('removes a collapsed paste with Delete at the boundary and keeps text before it', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const placeholder = '[pasted code 6 lines]';

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      act(() => {
        input.value = `explain${placeholder}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.setSelectionRange('explain'.length, 'explain'.length);
      });

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      });

      expect(input.value).toBe('explain');
      cleanup(root, container);
    });

    it('jumps over a collapsed paste with arrow keys', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      const placeholder = '[pasted code 6 lines]';

      await act(async () => {
        input.focus();
        pasteTextOnInput(input, 'a\nb\nc\nd\ne\nf');
        await new Promise((r) => setTimeout(r, 10));
      });

      act(() => {
        input.value = `before${placeholder}after`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const blockStart = 'before'.length;
      const blockEnd = blockStart + placeholder.length;

      act(() => {
        input.setSelectionRange(blockStart + 1, blockStart + 1);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      });
      expect(input.selectionStart).toBe(blockStart);

      act(() => {
        input.setSelectionRange(blockEnd - 1, blockEnd - 1);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      expect(input.selectionStart).toBe(blockEnd);

      cleanup(root, container);
    });

    it('does not route composer paste to the terminal surface', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [], 'composer only');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('composer only');
      expect(mockWriteTerminal).not.toHaveBeenCalled();
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
          id: 'np-code-1',
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

  it('renders long paths without break-words so they scroll instead of wrapping mid-token', () => {
    useAgentOutputStore.setState({
      lines: [
        {
          id: 'np-path-1',
          agent: 'NextPert',
          terminal_id: 't1',
          line: 'E:\\Repos\\Agents\\NextPert\\someLongFileNameThatShouldNotBreakMidToken.jpg',
          ts: new Date().toISOString(),
        },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const lineSpan = container.querySelector('.whitespace-pre-wrap');
    expect(lineSpan).not.toBeNull();
    expect(lineSpan?.classList.contains('overflow-x-auto')).toBe(true);
    expect(lineSpan?.classList.contains('break-words')).toBe(false);
    expect(container.textContent).toContain('someLongFileNameThatShouldNotBreakMidToken.jpg');
    cleanup(root, container);
  });

  it('does not affect normal chat lines when code-change cards are present', () => {
    useAgentOutputStore.setState({
      lines: [
        { id: 'np-hello-1', agent: 'NextPert', terminal_id: 't1', line: 'Hello world', ts: new Date().toISOString() },
        {
          id: 'np-code-2',
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
        { id: 'np-done-1', agent: 'NextPert', terminal_id: 't1', line: 'Done', ts: new Date().toISOString() },
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
          id: 'np-code-3',
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

  describe('ACP mode', () => {
    it('renders the ACP transcript, permission card, and live status in the footer', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });

      const store = useAcpSessionStore.getState();
      store.applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI', version: '1.0.0' },
        },
      });
      store.startUserTurn('NextPert', 's1', 'List files');
      store.startAssistantTurn('NextPert', 's1');
      store.applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          sessionId: 's1',
          toolCall: {
            toolCallId: 'tc1',
            title: 'Shell: ls',
            status: 'in_progress',
            content: [],
          },
        },
      });
      store.applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'permission_request',
          sessionId: 's1',
          requestId: 10,
          options: [
            { optionId: 'approve', name: 'Approve', kind: 'allow_once' },
            { optionId: 'approve_for_session', name: 'Approve for session', kind: 'allow_always' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
          toolCall: {
            toolCallId: 'tc1',
            title: 'Shell: ls',
            status: 'in_progress',
            content: [],
          },
        },
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

      expect(container.querySelector('[data-testid="acp-transcript"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="permission-request-card"]')).not.toBeNull();
      expect(container.textContent).toContain('Kimi Code CLI 1.0.0');

      const approveBtn = container.querySelector('[data-testid="permission-option-approve"]') as HTMLButtonElement;
      act(() => {
        approveBtn.click();
      });

      expect(mockSendAcpPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'NextPert',
          sessionId: 's1',
          permissionRequestId: 10,
          outcome: 'selected',
          optionId: 'approve',
        }),
      );

      cleanup(root, container);
    });

    it('sends ACP_PROMPT from the composer in ACP mode', () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.value = 'List files';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockSendAcpPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'NextPert', sessionId: 's1', text: 'List files' }),
      );
      expect(input.value).toBe('');
      cleanup(root, container);
    });

    it("cancels the in-flight turn when the human types 'stop' mid-turn (WO 11569)", async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: { sessionUpdate: 'prompt_queued', sessionId: 's1', queueDepth: 3 },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      // Start a turn so there is an in-flight assistant turn to interrupt.
      act(() => {
        input.value = 'List files';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(mockSendAcpPrompt).toHaveBeenCalledTimes(1);
      mockSendAcpPrompt.mockClear();

      act(() => {
        input.value = 'stop';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      // TIER 1 (WO 11635): the typed word interrupts — cancel fires
      // immediately; the queue is PRESERVED, never purged.
      expect(mockSendAcpCancel).toHaveBeenCalledWith({ agent: 'NextPert', sessionId: 's1' });
      expect(mockPurgeAcpQueue).not.toHaveBeenCalled();
      expect(mockSendAcpPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-interrupt-flash"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="purge-offer"]')).toBeNull();
      cleanup(root, container);
    });

    it('flushes input into the running turn on Ctrl+S (native steer parity, WO 11647)', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.value = 'first task';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(mockSendAcpPrompt).toHaveBeenCalledTimes(1);

      // Ctrl+S mid-turn: the input flushes into the running turn and clears.
      act(() => {
        input.value = 'listen to this now';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
      });

      expect(mockSendAcpPrompt).toHaveBeenCalledTimes(2);
      expect(mockSendAcpPrompt).toHaveBeenLastCalledWith(
        expect.objectContaining({ agent: 'NextPert', sessionId: 's1', text: 'listen to this now' }),
      );
      expect(input.value).toBe('');
      cleanup(root, container);
    });

    it('does nothing on Ctrl+S when idle (native guard)', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.value = 'draft';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
      });

      expect(mockSendAcpPrompt).not.toHaveBeenCalled();
      expect(input.value).toBe('draft');
      cleanup(root, container);
    });

    it('treats Escape as a tier-1 interrupt — cancel immediately, queue preserved (WO 11635)', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: { sessionUpdate: 'prompt_queued', sessionId: 's1', queueDepth: 3 },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.value = 'List files';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      // Escape interrupts: cancel fires; the queue is PRESERVED, never purged
      // (WO 11635 — the agent reads all 3 queued messages after the halt).
      expect(mockSendAcpCancel).toHaveBeenCalledWith({ agent: 'NextPert', sessionId: 's1' });
      expect(mockPurgeAcpQueue).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="purge-offer"]')).toBeNull();
      cleanup(root, container);
    });

    it('shows the interrupt flash on Ctrl+C as well (QAPert 11611 minor 1)', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.value = 'List files';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
      });

      expect(mockSendAcpCancel).toHaveBeenCalledWith({ agent: 'NextPert', sessionId: 's1' });
      expect(mockPurgeAcpQueue).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="terminal-interrupt-flash"]')).not.toBeNull();
      cleanup(root, container);
    });

    it('does nothing destructive on an idle Escape — no cancel, no purge (QAPert 11611 minor 2)', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: { sessionUpdate: 'prompt_queued', sessionId: 's1', queueDepth: 4 },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      input.value = 'draft text';

      // No turn in flight: Escape clears the draft but MUST NOT cancel or
      // purge the backlog — the destructive path is never accidental.
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(mockSendAcpCancel).not.toHaveBeenCalled();
      expect(mockPurgeAcpQueue).not.toHaveBeenCalled();
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-interrupt-flash"]')).toBeNull();
      cleanup(root, container);
    });

    it("sends 'stop' as a normal message when no turn is in-flight", () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.value = 'stop';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockSendAcpPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'NextPert', sessionId: 's1', text: 'stop' }),
      );
      expect(mockSendAcpCancel).not.toHaveBeenCalled();
      cleanup(root, container);
    });

    it('cancels the active ACP turn and shows an interrupt flash when Escape is pressed', () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      // Start a turn so the Escape has something to cancel (idle Escape is a
      // deliberate no-op per QAPert 11611).
      act(() => {
        input.focus();
        input.value = 'partial command';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      act(() => {
        input.value = 'draft';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(mockSendAcpCancel).toHaveBeenCalledWith({ agent: 'NextPert', sessionId: 's1' });
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-interrupt-flash"]')?.textContent).toContain('Interrupted');
      cleanup(root, container);
    });

    it('keeps the active assistant turn when the user sends mid-turn (slice B steer)', () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      const store = useAcpSessionStore.getState();
      store.applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
      });
      store.startUserTurn('NextPert', 's1', 'First');
      store.startAssistantTurn('NextPert', 's1');
      store.applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId: 's1',
          content: { type: 'content', content: { type: 'text', text: 'Working…' } },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const activeTurnIdBefore = useAcpSessionStore.getState().getSession('NextPert')?.activeTurnId;

      act(() => {
        input.focus();
        input.value = 'Second';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      const session = useAcpSessionStore.getState().getSession('NextPert');
      // The steered message joins the ACTIVE turn — no 'interrupted' kill, no
      // second assistant turn. activeTurnId is unchanged.
      expect(session?.activeTurnId).toBe(activeTurnIdBefore);
      expect(session?.turns).toHaveLength(3);
      expect(session?.turns[1].role).toBe('assistant');
      expect(session?.turns[1].status).not.toBe('done');
      expect(session?.turns[2].role).toBe('user');
      expect(session?.turns[2].contentText).toBe('Second');
      expect(mockSendAcpPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ agent: 'NextPert', sessionId: 's1', text: 'Second' }),
      );

      cleanup(root, container);
    });

    it('fails the active assistant turn when sendAcpPrompt rejects', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      mockSendAcpPrompt.mockRejectedValueOnce(new Error('IPC timeout'));

      const store = useAcpSessionStore.getState();
      store.applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        input.value = 'List files';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        // Flush the sendAcpPrompt rejection and failActiveTurn update.
        await Promise.resolve();
        await Promise.resolve();
      });

      const session = useAcpSessionStore.getState().getSession('NextPert');
      const assistantTurn = session?.turns.find((t) => t.role === 'assistant');
      expect(assistantTurn?.status).toBe('error');
      expect(assistantTurn?.contentText).toContain('IPC timeout');
      expect(container.textContent).toContain('IPC timeout');

      cleanup(root, container);
    });

    it('does not write to the PTY when sending input in ACP mode (echo suppression)', () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      act(() => {
        input.focus();
        input.value = 'List files';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockWriteTerminal).not.toHaveBeenCalled();
      cleanup(root, container);
    });

    it('does not render agent output store lines once the ACP session is initialized', () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAgentOutputStore.setState({
        lines: [
          { id: 'l1', agent: 'NextPert', terminal_id: 't1', line: 'raw PTY line', ts: new Date().toISOString() },
        ],
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI' },
        },
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
      expect(container.querySelector('[data-testid="acp-transcript"]')).not.toBeNull();
      expect(container.textContent).not.toContain('raw PTY line');
      cleanup(root, container);
    });

    it('falls back to the PTY surface while the ACP session is not initialized', () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAgentOutputStore.setState({
        lines: [
          { id: 'l1', agent: 'NextPert', terminal_id: 't1', line: 'raw PTY line', ts: new Date().toISOString() },
        ],
      });
      // Session exists but has no sessionId yet -> not initialized.
      useAcpSessionStore.setState({
        sessions: new Map([['NextPert', { turns: [], activeTurnId: null, runtimeMode: 'acp' }]]),
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
      expect(container.querySelector('[data-testid="acp-transcript"]')).toBeNull();
      expect(container.textContent).toContain('raw PTY line');
      cleanup(root, container);
    });
  });

  describe('image paste (ACP)', () => {
    let originalCreateObjectURL: unknown;
    let originalRevokeObjectURL: unknown;
    // Only the canvas spies created by mockCanvas — restoring ALL mocks would
    // wipe the file-shared mockSendAcpPrompt implementation.
    let canvasSpies: Array<{ mockRestore: () => void }> = [];

    beforeEach(() => {
      originalCreateObjectURL = (URL as unknown as Record<string, unknown>).createObjectURL;
      originalRevokeObjectURL = (URL as unknown as Record<string, unknown>).revokeObjectURL;
      (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:mock-preview');
      (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
      mockImageWithSize(100, 100);
    });

    afterEach(() => {
      (URL as unknown as Record<string, unknown>).createObjectURL = originalCreateObjectURL;
      (URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevokeObjectURL;
      for (const spy of canvasSpies) spy.mockRestore();
      canvasSpies = [];
    });

    function mockImageWithSize(width: number, height: number) {
      class MockImage {
        onload: (() => void) | null = null;
        onerror: ((err: unknown) => void) | null = null;
        naturalWidth = width;
        naturalHeight = height;
        width = width;
        height = height;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
      vi.stubGlobal('Image', MockImage);
    }

    function mockCanvas(reencodeDataUrl = 'data:image/png;base64,UKVFTkNPREVE') {
      const drawImage = vi.fn();
      let captured: { width: number; height: number } | null = null;
      const getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'getContext')
        .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
      const toDataURLSpy = vi
        .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
        .mockImplementation(function (this: HTMLCanvasElement) {
          captured = { width: this.width, height: this.height };
          return reencodeDataUrl;
        });
      canvasSpies.push(getContextSpy, toDataURLSpy);
      return { drawImage, getContextSpy, toDataURLSpy, getCaptured: () => captured };
    }

    function setupAcpSession(imageIn?: boolean): AgentState {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Kimi Code CLI', version: '0.27.0' },
          ...(imageIn === undefined ? {} : { imageIn }),
        },
      });
      return {
        id: '1',
        name: 'NextPert',
        displayName: 'NextPert',
        workDir: '',
        autoStart: false,
        position: 'top-left',
        status: 'busy',
        provider: 'kimi',
      };
    }

    async function pasteImageAndFlush(input: HTMLInputElement, files: File[], text?: string) {
      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, files, text);
        // Let FileReader + the mocked Image decode + setState settle.
        await new Promise((r) => setTimeout(r, 20));
      });
    }

    it('stages a removable chip when an image item is pasted', async () => {
      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);

      const chip = container.querySelector('[data-testid="staged-image-chip"]');
      expect(chip).not.toBeNull();
      expect(chip?.textContent).toContain('shot.png');
      expect(chip?.querySelector('img')?.getAttribute('src')).toBe('blob:mock-preview');
      cleanup(root, container);
    });

    it('renders the staged thumbnail legibly with preserved aspect ratio (no forced-square crop)', async () => {
      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);

      const img = container.querySelector('[data-testid="staged-image-chip"] img');
      expect(img).not.toBeNull();
      const cls = img?.getAttribute('class') ?? '';
      expect(cls).toContain('object-contain');
      expect(cls).not.toContain('object-cover');
      expect(cls).not.toContain('w-8 h-8');
      cleanup(root, container);
    });

    it('attaches a pasted image even when Enter is pressed before encoding finishes', async () => {
      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [file]);
        // No settle wait — send while staging is still in flight. The send
        // must await the pending staging instead of silently going text-only.
        input.value = 'Look at this';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(mockSendAcpPrompt).toHaveBeenCalledWith({
        agent: 'NextPert',
        sessionId: 's1',
        text: 'Look at this',
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' }],
      });
      cleanup(root, container);
    });

    it('surfaces a composer error and blocks the next send when the pasted image cannot be read', async () => {
      class FailingImage {
        onload: (() => void) | null = null;
        onerror: ((err: unknown) => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.(new Error('decode failed')));
        }
      }
      vi.stubGlobal('Image', FailingImage);

      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['garbage'], 'image.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);

      // No chip staged; a visible composer error names the failed image.
      expect(container.querySelector('[data-testid="staged-image-chip"]')).toBeNull();
      expect(container.querySelector('[data-testid="terminal-image-error"]')?.textContent).toContain('image.png');

      // The next Enter is swallowed with the error re-surfaced — the text must
      // not silently leave without the attachment.
      act(() => {
        input.value = 'Look at this';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(mockSendAcpPrompt).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="terminal-image-error"]')?.textContent).toContain('image.png');
      cleanup(root, container);
    });

    it('removes a staged chip via its remove button', async () => {
      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);
      expect(container.querySelector('[data-testid="staged-image-chip"]')).not.toBeNull();

      const removeButton = container.querySelector('[data-testid="staged-image-remove"]') as HTMLButtonElement;
      act(() => {
        removeButton.click();
      });

      expect(container.querySelector('[data-testid="staged-image-chip"]')).toBeNull();
      cleanup(root, container);
    });

    it('sends staged images with the prompt (base64 prefix stripped) and clears staging', async () => {
      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);
      expect(container.querySelector('[data-testid="staged-image-chip"]')).not.toBeNull();

      act(() => {
        input.value = 'Look at this';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockSendAcpPrompt).toHaveBeenCalledWith({
        agent: 'NextPert',
        sessionId: 's1',
        text: 'Look at this',
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' }],
      });
      expect(container.querySelector('[data-testid="staged-image-chip"]')).toBeNull();

      // The user turn in the transcript store carries the same image.
      const session = useAcpSessionStore.getState().getSession('NextPert');
      const userTurn = session?.turns.find((t) => t.role === 'user');
      expect(userTurn?.content[1]).toEqual({
        type: 'content',
        content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      });
      cleanup(root, container);
    });

    it('sends staged images when imageIn is true', async () => {
      const agent = setupAcpSession(true);
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);

      act(() => {
        input.value = 'Look at this';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockSendAcpPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ images: [{ data: 'aGVsbG8=', mimeType: 'image/png', name: 'shot.png' }] }),
      );
      cleanup(root, container);
    });

    it('refuses to send staged images when the active model has imageIn: false', async () => {
      const agent = setupAcpSession(false);
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);
      expect(container.querySelector('[data-testid="staged-image-chip"]')).not.toBeNull();

      act(() => {
        input.value = 'Look at this';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      expect(mockSendAcpPrompt).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Current model can't see images");
      // Staging survives the refusal so the user can keep or remove the chips.
      expect(container.querySelector('[data-testid="staged-image-chip"]')).not.toBeNull();
      // No half-sent turn was started in the transcript store.
      const session = useAcpSessionStore.getState().getSession('NextPert');
      expect(session?.turns ?? []).toHaveLength(0);
      cleanup(root, container);
    });

    it('still handles a text-only paste in ACP mode', async () => {
      const agent = setupAcpSession();
      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await pasteImageAndFlush(input, [], 'plain text only');

      expect(input.value).toBe('plain text only');
      expect(container.querySelector('[data-testid="staged-image-chip"]')).toBeNull();
      cleanup(root, container);
    });

    it('does not stage images in PTY mode', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      const file = new File(['hello'], 'shot.png', { type: 'image/png' });
      await pasteImageAndFlush(input, [file]);

      expect(container.querySelector('[data-testid="staged-image-chip"]')).toBeNull();
      cleanup(root, container);
    });

    describe('encodeImageForTransport', () => {
      it('passes a small PNG through untouched (no canvas re-encode)', async () => {
        const canvas = mockCanvas();
        const file = new File(['hello'], 'shot.png', { type: 'image/png' });

        const result = await encodeImageForTransport(file);

        expect(result.mimeType).toBe('image/png');
        expect(result.dataUrl).toBe('data:image/png;base64,aGVsbG8=');
        expect(canvas.getContextSpy).not.toHaveBeenCalled();
      });

      it('re-encodes a non-PNG to PNG via canvas', async () => {
        const canvas = mockCanvas();
        const file = new File(['hello'], 'shot.bmp', { type: 'image/bmp' });

        const result = await encodeImageForTransport(file);

        expect(result).toEqual({
          dataUrl: 'data:image/png;base64,UKVFTkNPREVE',
          mimeType: 'image/png',
        });
        expect(canvas.drawImage).toHaveBeenCalled();
        expect(canvas.getCaptured()).toEqual({ width: 100, height: 100 });
      });

      it('downscales images whose longest edge exceeds 2000px (transport cost only)', async () => {
        const canvas = mockCanvas();
        mockImageWithSize(4000, 2000);
        const file = new File(['hello'], 'big.png', { type: 'image/png' });

        const result = await encodeImageForTransport(file);

        expect(result.mimeType).toBe('image/png');
        expect(result.dataUrl).toBe('data:image/png;base64,UKVFTkNPREVE');
        expect(canvas.getCaptured()).toEqual({ width: 2000, height: 1000 });
      });

      it('rejects when the renderer cannot decode the bytes (corrupt clipboard data)', async () => {
        class FailingImage {
          onload: (() => void) | null = null;
          onerror: ((err: unknown) => void) | null = null;
          set src(_value: string) {
            queueMicrotask(() => this.onerror?.(new Error('decode failed')));
          }
        }
        vi.stubGlobal('Image', FailingImage);
        const file = new File(['hello'], 'weird.avif', { type: 'image/avif' });

        // Undecodable bytes can never be previewed and shipping them raw was
        // the silent-loss vector — the composer must fail loudly instead.
        await expect(encodeImageForTransport(file)).rejects.toThrow('image decode failed');
      });
    });
  });

  it('injects a deterministic user-source line when sending input in PTY mode', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

    act(() => {
      input.value = 'build now';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(mockWriteTerminal).toHaveBeenCalledWith('t1', 'build now\r');
    const userLine = useAgentOutputStore.getState().lines.find(
      (l) => l.agent === 'NextPert' && l.source === 'user',
    );
    expect(userLine).toBeDefined();
    expect(userLine?.line).toBe('build now');
    cleanup(root, container);
  });

  it('recalls previous inputs with Up/Down arrows in the composer', () => {
    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

    act(() => {
      input.value = 'first command';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    act(() => {
      input.value = 'second command';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(input.value).toBe('second command');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(input.value).toBe('first command');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(input.value).toBe('second command');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(input.value).toBe('');

    cleanup(root, container);
  });

  it('renders user bubbles with break-words and without overflow-x-auto', () => {
    useAgentOutputStore.setState({
      lines: [
        {
          id: 'u1',
          agent: 'NextPert',
          terminal_id: 't1',
          line: 'A longer user message that should wrap at words.',
          source: 'user',
          ts: new Date().toISOString(),
        },
      ],
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const userSpan = container.querySelector('[class*="bg-blue-600/25"]');
    expect(userSpan).not.toBeNull();
    expect(userSpan?.classList.contains('break-words')).toBe(true);
    expect(userSpan?.classList.contains('overflow-x-auto')).toBe(false);
    cleanup(root, container);
  });

  it('scrolls to bottom when the New output button is clicked in ACP mode', () => {
    // Initialize an ACP session so the transcript surface is active.
    useAcpSessionStore.getState().applyEvent({
      agent: 'NextPert',
      sessionId: 's1',
      update: {
        sessionUpdate: 'initialized',
        sessionId: 's1',
        capabilities: {},
        agentInfo: { name: 'Kimi', version: '1.0.0' },
      },
    });

    // Seed enough PTY lines that the button logic has something to track.
    useAgentOutputStore.setState({
      lines: Array.from({ length: 5 }, (_, i) => ({
        id: `line-${i}`,
        agent: 'NextPert',
        terminal_id: 't1',
        line: `Line ${i}`,
        source: 'agent' as const,
        ts: new Date().toISOString(),
      })),
    });

    const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
    const host = container.querySelector('[data-testid="terminal-host"]') as HTMLElement;
    const measure = container.querySelector('[data-testid="terminal-measure"]') as HTMLElement;
    const scroll = container.querySelector('[role="log"]') as HTMLElement;
    setMeasuredSizes(host, measure, scroll);

    // Scroll up so the surface pauses following.
    act(() => {
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    // Add another line while paused to trigger the "New output" button.
    act(() => {
      useAgentOutputStore.getState().addLine({
        agent: 'NextPert',
        terminal_id: 't1',
        line: 'New line',
        source: 'agent',
        ts: new Date().toISOString(),
      });
    });

    const button = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('New output'),
    );
    expect(button).toBeDefined();

    act(() => {
      button!.click();
    });

    expect(scroll.scrollTop + scroll.clientHeight).toBe(scroll.scrollHeight);

    cleanup(root, container);
  });
});
