import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useVsqlCacheSse } from './useVsqlCacheSse';
import { useAppStore } from '../stores/appStore';
import { useProjectStore } from '../stores/projectStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetVsqlCacheAuthHeaders = vi.fn();
const mockGetActiveSessionToken = vi.fn();

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
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('electronAPI', {
    getVsqlCacheAuthHeaders: mockGetVsqlCacheAuthHeaders,
    getActiveSessionToken: mockGetActiveSessionToken,
  });
  mockGetVsqlCacheAuthHeaders.mockResolvedValue({
    url: 'http://localhost:32786',
    Authorization: 'Bearer test-token',
  });
  mockGetActiveSessionToken.mockResolvedValue({ token: 'test-session-token' });

  useAppStore.setState({
    backendAvailable: true,
    agents: [],
  } as unknown as ReturnType<typeof useAppStore.getState>);

  useProjectStore.setState({
    activeProject: { id: 284, name: 'TestProject' },
    pickerHasStarted: true,
    currentProjectTeam: [],
  } as unknown as ReturnType<typeof useProjectStore.getState>);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useVsqlCacheSse', () => {
  it('does not call fetch until agents are loaded', async () => {
    renderHook(() => useVsqlCacheSse());

    // Allow any queued microtasks to run.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(fetch).not.toHaveBeenCalled();
    expect(mockGetVsqlCacheAuthHeaders).not.toHaveBeenCalled();
  });

  it('calls auth headers and fetch once agents are available', async () => {
    useAppStore.setState({
      agents: [{ name: 'DotNetPert' }],
    } as unknown as ReturnType<typeof useAppStore.getState>);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
          cancel: vi.fn(),
        }),
      },
    });

    renderHook(() => useVsqlCacheSse());

    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));

    expect(mockGetVsqlCacheAuthHeaders).toHaveBeenCalledWith('GET', '/v1/agent-output/stream');
    expect(mockGetActiveSessionToken).toHaveBeenCalledWith(284);
    expect(fetch).toHaveBeenCalled();
    const firstCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = new URL(firstCall[0]);
    expect(url.pathname).toBe('/v1/agent-output/stream');
    expect(url.searchParams.get('projectId')).toBe('284');
    expect(url.searchParams.get('agents')).toBe('DotNetPert');
    const fetchHeaders = firstCall[1].headers as Record<string, string>;
    expect(fetchHeaders['X-Session-Token']).toBe('test-session-token');
  });
});
