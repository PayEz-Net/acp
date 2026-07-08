import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useInputHistory } from './useInputHistory';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const result = { current: undefined as unknown as T };
  function TestComponent() {
    result.current = useHook();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<TestComponent />));
  return {
    result,
    cleanup: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useInputHistory', () => {
  it('returns null when cycling an empty history', () => {
    const { result, cleanup } = renderHook(() => useInputHistory('agent-a', 'session-1'));
    let next: string | null = '';
    act(() => {
      next = result.current.cycle('up', 'draft');
    });
    expect(next).toBeNull();
    cleanup();
  });

  it('recalls committed entries in reverse order on Up and restores draft on Down', () => {
    const { result, cleanup } = renderHook(() => useInputHistory('agent-b', 'session-1'));

    act(() => {
      result.current.commit('one');
      result.current.commit('two');
      result.current.commit('three');
    });

    let value = '';
    act(() => {
      value = result.current.cycle('up', 'current draft') ?? '';
    });
    expect(value).toBe('three');

    act(() => {
      value = result.current.cycle('up', value) ?? '';
    });
    expect(value).toBe('two');

    act(() => {
      value = result.current.cycle('down', value) ?? '';
    });
    expect(value).toBe('three');

    act(() => {
      value = result.current.cycle('down', value) ?? '';
    });
    expect(value).toBe('current draft');

    cleanup();
  });

  it('caps history at 50 entries', () => {
    const { result, cleanup } = renderHook(() => useInputHistory('agent-c', 'session-1'));

    act(() => {
      for (let i = 0; i < 55; i++) {
        result.current.commit(`msg-${i}`);
      }
    });

    let value = '';
    act(() => {
      for (let i = 0; i < 50; i++) {
        value = result.current.cycle('up', value) ?? '';
      }
    });
    expect(value).toBe('msg-5');

    cleanup();
  });

  it('does not store duplicate consecutive entries', () => {
    const { result, cleanup } = renderHook(() => useInputHistory('agent-d', 'session-1'));

    act(() => {
      result.current.commit('same');
      result.current.commit('same');
      result.current.commit('same');
    });

    let value = '';
    act(() => {
      value = result.current.cycle('up', '') ?? '';
    });
    expect(value).toBe('same');

    act(() => {
      value = result.current.cycle('up', value) ?? '';
    });
    expect(value).toBe('same');

    cleanup();
  });

  it('isolates histories by agent and session', () => {
    const { result: a, cleanup: cleanupA } = renderHook(() => useInputHistory('agent-e', 'session-1'));
    const { result: b, cleanup: cleanupB } = renderHook(() => useInputHistory('agent-e', 'session-2'));
    const { result: c, cleanup: cleanupC } = renderHook(() => useInputHistory('agent-f', 'session-1'));

    act(() => {
      a.current.commit('a-only');
      b.current.commit('b-only');
      c.current.commit('c-only');
    });

    let value = '';
    act(() => {
      value = a.current.cycle('up', '') ?? '';
    });
    expect(value).toBe('a-only');

    act(() => {
      value = b.current.cycle('up', '') ?? '';
    });
    expect(value).toBe('b-only');

    act(() => {
      value = c.current.cycle('up', '') ?? '';
    });
    expect(value).toBe('c-only');

    cleanupA();
    cleanupB();
    cleanupC();
  });
});
