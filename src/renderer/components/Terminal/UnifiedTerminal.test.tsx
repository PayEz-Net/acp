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
const mockTriggerPaste = vi.fn();
const mockSendTerminalWithImages = vi.fn();

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
    sendTerminalWithImages: mockSendTerminalWithImages,
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
  Object.defineProperty(target, 'scrollTop', { configurable: true, value: 0 });
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
    // The footer shows the compact Thinking… status pill.
    expect(container.textContent).toContain('Thinking…');
    cleanup(root, container);
  });

  it('keeps the footer thinking indicator current as live thinking updates', async () => {
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
    expect(container.textContent).toContain('Thinking…');

    act(() => {
      useAgentOutputStore.setState({
        lines: [
          { id: 'np-answer-1', agent: 'NextPert', terminal_id: 't1', line: 'Here is the answer', thinking: 'step one\nstep two', thinkingLive: false, ts: new Date().toISOString() },
        ],
      });
    });

    // Footer drops the live indicator; stream now shows the finalized answer.
    expect(container.textContent).toContain('Here is the answer');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });
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

    it('sends staged images via sendTerminalWithImages on Enter', async () => {
      mockSendTerminalWithImages.mockResolvedValue({ success: true });
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
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
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(mockSendTerminalWithImages).toHaveBeenCalledTimes(1);
      const payload = mockSendTerminalWithImages.mock.lastCall?.[0];
      expect(payload.terminalId).toBe('t1');
      expect(payload.text).toBe('what is this?');
      expect(payload.images).toHaveLength(1);
      expect(input.value).toBe('');
      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
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

    it('shows a provider mismatch notice for unsupported runtimes', async () => {
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

      expect(container.querySelector('[data-testid="terminal-provider-mismatch"]')).not.toBeNull();
      cleanup(root, container);
    });

    it('sends pasted images immediately when instant-send is enabled and the composer is empty', async () => {
      mockSendTerminalWithImages.mockResolvedValue({ success: true });
      useAppStore.setState({ settings: { instantSendPastedImages: true } as any });
      useProjectStore.setState({
        activeProject: { id: 1, name: 'acp-desktop', runtime_choice: 'kimi' } as any,
      });
      const { container, root } = render(<UnifiedTerminal agentName="NextPert" terminalId="t1" />);
      const input = container.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;

      await act(async () => {
        input.focus();
        pasteFilesOnInput(input, [createImageFile()]);
        await new Promise((r) => setTimeout(r, 100));
      });

      expect(mockSendTerminalWithImages).toHaveBeenCalledTimes(1);
      const payload = mockSendTerminalWithImages.mock.lastCall?.[0];
      expect(payload.terminalId).toBe('t1');
      expect(payload.text).toBe('');
      expect(payload.images).toHaveLength(1);
      expect(container.querySelector('[data-testid="terminal-image-previews"]')).toBeNull();
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
});
