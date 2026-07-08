import { describe, it, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import { ThinkingBlock } from './ThinkingBlock';

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

describe('ThinkingBlock', () => {
  it('indents wrapped thinking content past the toggle chevron', () => {
    const content = 'Line one\n• bullet\n  wrapped continuation';
    const { container, root } = render(
      <ThinkingBlock content={content} defaultExpanded />,
    );
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.classList.contains('pl-[1.125rem]')).toBe(true);
    cleanup(root, container);
  });

  it('renders expanded content', () => {
    const content = 'step one\nstep two';
    const { container, root } = render(<ThinkingBlock content={content} defaultExpanded />);
    expect(container.textContent).toContain('step one');
    expect(container.textContent).toContain('step two');
    cleanup(root, container);
  });

  it('renders a two-line preview when collapsed', () => {
    const content = 'alpha\nbeta\ngamma';
    const { container, root } = render(<ThinkingBlock content={content} />);
    expect(container.textContent).toContain('alpha');
    expect(container.textContent).toContain('beta');
    expect(container.textContent).toContain('1 more lines');
    cleanup(root, container);
  });
});
