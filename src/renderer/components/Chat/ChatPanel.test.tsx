import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { ChatPanel } from './ChatPanel';
import { useChatStore } from '../../stores/chatStore';
import { useAppStore } from '../../stores/appStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function cleanup(root: ReturnType<typeof createRoot>, container: HTMLElement) {
  act(() => {
    root.unmount();
  });
  document.body.removeChild(container);
}

function typeInto(input: HTMLTextAreaElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function mockFetch(response: { ok?: boolean; json?: unknown; status?: number } = {}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.json ?? {},
  } as Response);
}

beforeEach(() => {
  useChatStore.setState({
    conversations: [],
    selectedConversation: null,
    messages: [],
    loading: false,
    error: undefined,
  });
  useAppStore.setState({
    backendAvailable: true,
    agents: [
      { id: 'u1', name: 'Jon' },
      { id: 'a1', name: 'NextPert' },
    ],
    activeAgentId: 'u1',
  } as any);
  vi.stubGlobal('fetch', mockFetch({ json: { data: [] } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ChatPanel', () => {
  it('renders the conversation list and message thread', () => {
    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          participants: ['Jon', 'NextPert'],
          unreadCount: 0,
          createdAt: new Date().toISOString(),
          lastMessage: {
            id: 'm1',
            conversationId: 'c1',
            from: 'NextPert',
            body: 'Hello',
            createdAt: new Date().toISOString(),
          },
        },
      ],
    });

    const { container, root } = render(<ChatPanel isOpen onClose={() => {}} />);
    expect(container.textContent).toContain('NextPert');
    expect(container.textContent).toContain('Hello');
    cleanup(root, container);
  });

  it('renders deterministic user bubbles immediately on send', async () => {
    const sendSpy = vi
      .spyOn(useChatStore.getState(), 'sendMessage')
      .mockImplementation(async (conversationId, from, body) => {
        useChatStore.setState((state) => ({
          messages: [
            ...state.messages,
            {
              id: 'real-1',
              conversationId,
              from,
              body,
              createdAt: new Date().toISOString(),
            },
          ],
        }));
        return true;
      });
    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          participants: ['Jon', 'NextPert'],
          unreadCount: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      selectedConversation: {
        id: 'c1',
        participants: ['Jon', 'NextPert'],
        unreadCount: 0,
        createdAt: new Date().toISOString(),
      },
    });

    const { container, root } = render(<ChatPanel isOpen onClose={() => {}} />);
    const input = container.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement;

    await act(async () => {
      input.focus();
      typeInto(input, 'Do this now');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(sendSpy).toHaveBeenCalledWith('c1', 'Jon', 'Do this now');
    expect(container.textContent).toContain('Do this now');
    // User bubbles are right-aligned.
    const bubble = container.querySelector('[data-testid="chat-message"]');
    expect(bubble?.className).toContain('justify-end');

    cleanup(root, container);
  });

  it('cycles through input history with Up/Down arrows', async () => {
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(true);
    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          participants: ['Jon', 'NextPert'],
          unreadCount: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      selectedConversation: {
        id: 'c1',
        participants: ['Jon', 'NextPert'],
        unreadCount: 0,
        createdAt: new Date().toISOString(),
      },
    });

    const { container, root } = render(<ChatPanel isOpen onClose={() => {}} />);
    const input = container.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement;

    await act(async () => {
      typeInto(input, 'First');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      typeInto(input, 'Second');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      typeInto(input, 'draft');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await Promise.resolve();
    });
    expect(input.value).toBe('Second');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await Promise.resolve();
    });
    expect(input.value).toBe('First');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
    });
    expect(input.value).toBe('Second');

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await Promise.resolve();
    });
    expect(input.value).toBe('draft');

    cleanup(root, container);
  });

  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const sendSpy = vi.spyOn(useChatStore.getState(), 'sendMessage').mockResolvedValue(true);
    useChatStore.setState({
      conversations: [
        {
          id: 'c1',
          participants: ['Jon', 'NextPert'],
          unreadCount: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      selectedConversation: {
        id: 'c1',
        participants: ['Jon', 'NextPert'],
        unreadCount: 0,
        createdAt: new Date().toISOString(),
      },
    });

    const { container, root } = render(<ChatPanel isOpen onClose={() => {}} />);
    const input = container.querySelector('[data-testid="chat-input"]') as HTMLTextAreaElement;

    await act(async () => {
      typeInto(input, 'Line one');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(input.value).toContain('\n');
    expect(sendSpy).not.toHaveBeenCalled();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(sendSpy).toHaveBeenCalledWith('c1', 'Jon', expect.stringContaining('Line one'));

    cleanup(root, container);
  });
});
