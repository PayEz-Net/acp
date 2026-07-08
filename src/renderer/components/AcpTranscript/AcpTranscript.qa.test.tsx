import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { AcpTranscript } from './AcpTranscript';
import type { AcpTurn } from '@shared/acpTypes';

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

function makeTurn(overrides: Partial<AcpTurn> = {}): AcpTurn {
  return {
    id: 't1',
    agent: 'NextPert',
    sessionId: 's1',
    role: 'assistant',
    status: 'done',
    content: [],
    contentText: '',
    thinking: '',
    toolCalls: [],
    ts: new Date().toISOString(),
    ...overrides,
  };
}

describe('AcpTranscript QA — no system lines', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // TODO(QAPert): Enable this test once Task 1 transport filtering is
  // implemented. The transport must drop ACP Desktop system/mail lines before
  // they reach the store. This test will fail until that filtering exists.
  it.skip('does not render ACP Desktop system or mail notification lines', () => {
    const turns: AcpTurn[] = [
      makeTurn({ id: 'u1', role: 'user', contentText: 'Hello' }),
      makeTurn({
        id: 'a1',
        role: 'assistant',
        contentText: '[ACP mail] New message from BAPert',
      }),
      makeTurn({
        id: 'a2',
        role: 'assistant',
        contentText: '[ACP system] spawn complete',
      }),
    ];
    const { container, root } = render(<AcpTranscript turns={turns} activeTurnId={null} />);

    // Requirement: ACP transcript must never contain ACP Desktop system or
    // mail notifications. If these strings are visible, the transport filter
    // is incomplete.
    expect(container.textContent).not.toContain('[ACP mail]');
    expect(container.textContent).not.toContain('[ACP system]');

    cleanup(root, container);
  });
});
