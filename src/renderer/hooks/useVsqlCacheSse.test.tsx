import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useVsqlCacheSse } from './useVsqlCacheSse';
import { useAppStore } from '../stores/appStore';
import { useProjectStore } from '../stores/projectStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockAuthGetAccessToken = vi.fn();
const mockGetCloudEndpoints = vi.fn();

const cleanups: Array<() => void> = [];

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
  const cleanup = () => {
    act(() => root.unmount());
    document.body.removeChild(container);
  };
  // Track every mounted hook so afterEach can unmount them all — otherwise a
  // hook's reconnect timers outlive its test and fire during later tests that
  // advance fake time, polluting shared fetch call counts.
  cleanups.push(cleanup);
  return { result, cleanup };
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('fetch', vi.fn());
  vi.stubGlobal('electronAPI', {
    authGetAccessToken: mockAuthGetAccessToken,
    getCloudEndpoints: mockGetCloudEndpoints,
  });
  mockAuthGetAccessToken.mockResolvedValue('test-token');
  mockGetCloudEndpoints.mockResolvedValue({
    vibeApiUrl: 'http://localhost:32786',
    hubUrl: 'http://localhost:32787',
    idpUrl: 'http://localhost:32788',
    envName: 'test',
    isPackaged: false,
    isInternalDevBuild: false,
  });

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
  while (cleanups.length) cleanups.pop()!();
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
    expect(mockAuthGetAccessToken).not.toHaveBeenCalled();
  });

  it('calls auth token and fetch once agents are available', async () => {
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

    expect(mockAuthGetAccessToken).toHaveBeenCalled();
    expect(mockGetCloudEndpoints).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalled();
    const firstCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const url = new URL(firstCall[0]);
    expect(url.pathname).toBe('/v1/agent-output/stream');
    expect(url.searchParams.get('projectId')).toBe('284');
    expect(url.searchParams.get('agents')).toBe('DotNetPert');
    const fetchHeaders = firstCall[1].headers as Record<string, string>;
    expect(fetchHeaders.Authorization).toBe('Bearer test-token');
    expect(fetchHeaders.Accept).toBe('text/event-stream');
  });

  it('does not abort a healthy stream once connected (connect cap must not bound stream lifetime)', async () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({
        agents: [{ name: 'DotNetPert' }],
      } as unknown as ReturnType<typeof useAppStore.getState>);

      // Stream stays open with no events; read() rejects only if the fetch
      // signal aborts — mimics real fetch behavior so a self-inflicted abort
      // (the old AbortSignal.timeout(2000) bug) would surface as a reconnect.
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (_url: string, init: RequestInit) =>
          Promise.resolve({
            ok: true,
            body: {
              getReader: () => ({
                read: vi.fn().mockImplementation(
                  () =>
                    new Promise((_resolve, reject) => {
                      init.signal?.addEventListener('abort', () =>
                        reject(new DOMException('The user aborted a request.', 'AbortError')),
                      );
                    }),
                ),
                cancel: vi.fn(),
              }),
            },
          }),
      );

      renderHook(() => useVsqlCacheSse());

      await vi.advanceTimersByTimeAsync(100);
      expect(fetch).toHaveBeenCalledTimes(1);

      // Advance well past the old 2s cap and the new 10s connect window:
      // a healthy stream must not be aborted, so no reconnect may fire.
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a healthy stream alive past the old 2s cap (real-time regression for the AbortSignal.timeout bug)', async () => {
    // NOTE: real timers on purpose. AbortSignal.timeout() runs on Node's
    // internal clock, which vi.useFakeTimers() cannot advance — so a fake-time
    // version of this test passes even with the old buggy code (verified).
    // The old implementation aborted the stream at 2s and logged the
    // '[VsqlCacheSse] Error (retry …)' line; the fix must not.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      agents: [{ name: 'DotNetPert' }],
    } as unknown as ReturnType<typeof useAppStore.getState>);

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      (_url: string, init: RequestInit) =>
        Promise.resolve({
          ok: true,
          body: {
            getReader: () => ({
              read: vi.fn().mockImplementation(
                () =>
                  new Promise((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () =>
                      reject(new DOMException('The user aborted a request.', 'AbortError')),
                    );
                  }),
              ),
              cancel: vi.fn(),
            }),
          },
        }),
    );

    renderHook(() => useVsqlCacheSse());

    await act(() => new Promise((resolve) => setTimeout(resolve, 2800)));

    expect(fetch).toHaveBeenCalledTimes(1);
    const retryErrors = consoleSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[VsqlCacheSse] Error'),
    );
    expect(retryErrors).toHaveLength(0);
    consoleSpy.mockRestore();
  }, 10000);

  it('aborts a stalled connect after the connect timeout and retries (AC6)', async () => {
    vi.useFakeTimers();
    try {
      useAppStore.setState({
        agents: [{ name: 'DotNetPert' }],
      } as unknown as ReturnType<typeof useAppStore.getState>);

      // Headers never arrive; reject when the fetch signal aborts.
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('The user aborted a request.', 'AbortError')),
            );
          }),
      );

      renderHook(() => useVsqlCacheSse());

      await vi.advanceTimersByTimeAsync(100);
      expect(fetch).toHaveBeenCalledTimes(1);

      // 10s connect cap fires → abort → backoff (~2-3s) → retry connect.
      await vi.advanceTimersByTimeAsync(16000);
      expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
