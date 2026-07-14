import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

import { UnifiedTerminal } from './UnifiedTerminal';
import { useAgentOutputStore } from '../../stores/agentOutputStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAcpSessionStore } from '../../stores/acpSessionStore';
import { getTelemetryQueue, clearTelemetryQueue } from '../../lib/telemetry';
import type { AgentState } from '@shared/types';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockWriteTerminal = vi.fn();
const mockResizeTerminal = vi.fn();
const mockReadClipboardText = vi.fn();
const mockTriggerPaste = vi.fn();

const mockSendAcpPrompt = vi.fn().mockResolvedValue(undefined);
const mockSendAcpMessage = vi.fn().mockResolvedValue(undefined);
const mockSendAcpCancel = vi.fn().mockResolvedValue(undefined);
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
    sendAcpMessage: mockSendAcpMessage,
    sendAcpCancel: mockSendAcpCancel,
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

function createImageFile(name = 'test.png', type = 'image/png'): File {
  // A minimal 1x1 transparent PNG.
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
    0x0d, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0x60, 0x60,
    0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0a, 0x3a, 0x32, 0x9d, 0x00, 0x00,
    0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return new File([bytes], name, { type });
}

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

    it('pastes text into the composer when image paste is disabled', async () => {
      useAppStore.setState({ settings: { enableTerminalImagePaste: false } as any });
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [], 'plain text');
        await new Promise((r) => setTimeout(r, 10));
      });

      expect(input.value).toBe('plain text');
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

    it('stages an image pasted into the composer', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();
      cleanup(root, container);
    });

    it('clears staged images when Escape is pressed', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
      cleanup(root, container);
    });

    it('shows an ACP-only notice for non-ACP mode', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: null } as any,
      });
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-acp-only"]')).not.toBeNull();
      cleanup(root, container);
    });

    it('stages both image and text when the clipboard contains both', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()], 'look at this');
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();
      expect(input.value).toBe('look at this');
      cleanup(root, container);
    });

    it('removes a preview when the remove button is clicked', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();

      const removeBtn = container.querySelector('[aria-label^="Remove pasted image"]') as HTMLButtonElement;
      expect(removeBtn).not.toBeNull();

      act(() => {
        removeBtn.click();
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
      expect(document.activeElement).toBe(input);
      cleanup(root, container);
    });

    it('emits image_paste_failed telemetry when sending images in unsupported provider mode', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: null } as any,
      });
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      const failedEvent = getTelemetryQueue().find((e) => e.event === 'image_paste_failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).errorCode).toBe('UNSUPPORTED_PROVIDER');
      cleanup(root, container);
    });

    it('shows an inline error for unsupported image formats', async () => {
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [new File(['bmp'], 'scan.bmp', { type: 'image/bmp' })]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-error"]')?.textContent).toContain('image/bmp is not supported');
      cleanup(root, container);
    });

    it('ignores image paste when the feature flag is disabled', async () => {
      useAppStore.setState({ settings: { enableTerminalImagePaste: false } as any });
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
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

      act(() => {
        input.focus();
        input.value = 'partial command';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(mockSendAcpCancel).toHaveBeenCalledWith({ agent: 'NextPert', sessionId: 's1' });
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-interrupt-flash"]')?.textContent).toContain('Interrupted');
      cleanup(root, container);
    });

    it('stops an active assistant turn when the user sends a new message', () => {
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

      act(() => {
        input.focus();
        input.value = 'Second';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      const session = useAcpSessionStore.getState().getSession('NextPert');
      expect(session?.turns).toHaveLength(4);
      expect(session?.turns[1].role).toBe('assistant');
      expect(session?.turns[1].status).toBe('done');
      expect(session?.turns[1].stopReason).toBe('interrupted');
      expect(session?.activeTurnId).toBe(session?.turns[3].id);
      expect(session?.turns[3].role).toBe('assistant');
      expect(session?.turns[3].status).toBe('thinking');
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

    it('stages an image pasted into the composer in ACP mode', async () => {
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

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();
      cleanup(root, container);
    });

    it('sends structured content blocks via sendAcpMessage when exposed', async () => {
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

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      act(() => {
        input.value = 'what is this?';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(mockSendAcpMessage).toHaveBeenCalledTimes(1);
      const payload = mockSendAcpMessage.mock.lastCall?.[0];
      expect(payload.agent).toBe('NextPert');
      expect(payload.sessionId).toBe('s1');
      expect(payload.content).toHaveLength(2);
      expect(payload.content[0]).toEqual({ type: 'text', text: 'what is this?' });
      expect(payload.content[1].type).toBe('image');
      expect(payload.content[1].mimeType).toBe('image/png');
      expect(payload.content[1].data).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();

      const sentEvent = getTelemetryQueue().find((e) => e.event === 'image_paste_sent');
      expect(sentEvent).toBeDefined();
      expect(sentEvent).not.toHaveProperty('provider');

      cleanup(root, container);
    });

    it('allows image paste in ACP mode regardless of provider name', async () => {
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'custom-acp-harness' } as any,
      });
      useAcpSessionStore.getState().applyEvent({
        agent: 'NextPert',
        sessionId: 's1',
        update: {
          sessionUpdate: 'initialized',
          sessionId: 's1',
          capabilities: {},
          agentInfo: { name: 'Custom ACP' },
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
        provider: 'custom-acp-harness' as any,
      };

      const { container, root } = render(<UnifiedTerminal agent={agent} terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="terminal-acp-only"]')).toBeNull();

      act(() => {
        input.value = 'what is this?';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(mockSendAcpMessage).toHaveBeenCalledTimes(1);
      const payload = mockSendAcpMessage.mock.lastCall?.[0];
      expect(payload.agent).toBe('NextPert');
      expect(payload.sessionId).toBe('s1');
      expect(payload.content).toHaveLength(2);
      expect(payload.content[0]).toEqual({ type: 'text', text: 'what is this?' });
      expect(payload.content[1].type).toBe('image');

      cleanup(root, container);
    });

    it('clears staged images when Escape is pressed in ACP mode', async () => {
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

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
      cleanup(root, container);
    });

    it('emits image_paste_failed telemetry when ACP send rejects', async () => {
      mockSendAcpMessage.mockRejectedValueOnce(new Error('IPC failure'));

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

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 50));
      });

      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const failedEvent = getTelemetryQueue().find((e) => e.event === 'image_paste_failed');
      expect(failedEvent).toBeDefined();
      expect((failedEvent as any).errorCode).toBe('IPC_ERROR');
      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();

      const session = useAcpSessionStore.getState().getSession('NextPert');
      expect(session?.activeTurnId).toBeNull();
      const assistantTurn = session?.turns.find((t) => t.role === 'assistant');
      expect(assistantTurn?.status).toBe('error');
      expect(assistantTurn?.contentText).toContain('IPC failure');
      cleanup(root, container);
    });

    it('stages both image and text when the clipboard contains both in ACP mode', async () => {
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

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()], 'look at this');
        await new Promise((r) => setTimeout(r, 50));
      });

      expect(container.querySelector('[data-testid="terminal-image-previews"]')).not.toBeNull();
      expect(input.value).toBe('look at this');
      cleanup(root, container);
    });

    it('shows a validation error for oversized images in ACP mode', async () => {
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

      await act(async () => {
        input.focus();
        const file = new File(['x'], 'huge.png', { type: 'image/png' });
        Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 });
        pasteFilesOnInput(input, [file]);
        await new Promise((r) => setTimeout(r, 50));
      });

      const errorEl = container.querySelector('[data-testid="terminal-image-error"]');
      expect(errorEl).not.toBeNull();
      expect(errorEl?.textContent).toContain('max 10.0 MB');
      cleanup(root, container);
    });

    it('instant-sends a pasted image in ACP mode when the composer is empty', async () => {
      useAppStore.setState({ settings: { instantSendPastedImages: true } as any });
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

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(mockSendAcpMessage).toHaveBeenCalledTimes(1);
      const payload = mockSendAcpMessage.mock.lastCall?.[0];
      expect(payload.content).toHaveLength(1);
      expect(payload.content[0].type).toBe('image');
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
      cleanup(root, container);
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
