/**
 * PTY output reporter unit tests.
 *
 * Verifies batching, flushing, and the graceful-disable path that avoids
 * spamming the console when vsql-cache is not configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isVsqlCacheReportingEnabled, postAgentOutput } from './vsql-cache-client';

vi.mock('./vsql-cache-client', () => ({
  isVsqlCacheReportingEnabled: vi.fn(),
  postAgentOutput: vi.fn().mockResolvedValue(undefined),
}));

async function loadReporter() {
  const mod = await import('./ptyOutputReporter');
  return mod;
}

describe('ptyOutputReporter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.mocked(isVsqlCacheReportingEnabled).mockReturnValue(true);
    vi.mocked(postAgentOutput).mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('batches chunks and flushes after the interval', async () => {
    const { reportPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'a');
    reportPtyOutput('DotNetPert', 't1', 'b');
    reportPtyOutput('DotNetPert', 't1', 'c');
    expect(postAgentOutput).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);

    expect(postAgentOutput).toHaveBeenCalledTimes(1);
    expect(postAgentOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'DotNetPert',
        terminalId: 't1',
        data: 'abc',
      }),
    );
  });

  it('flushes immediately when the buffer reaches the byte threshold', async () => {
    const { reportPtyOutput } = await loadReporter();
    const chunk = 'x'.repeat(8192);

    reportPtyOutput('DotNetPert', 't1', chunk);

    // Micro-task flush so the async postAgentOutput resolves synchronously.
    await Promise.resolve();

    expect(postAgentOutput).toHaveBeenCalledTimes(1);
    expect(postAgentOutput).toHaveBeenCalledWith(
      expect.objectContaining({ data: chunk }),
    );
  });

  it('flushPtyOutput sends pending chunks immediately', async () => {
    const { reportPtyOutput, flushPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'now');
    expect(postAgentOutput).not.toHaveBeenCalled();

    flushPtyOutput('t1');
    await Promise.resolve();

    expect(postAgentOutput).toHaveBeenCalledTimes(1);
    expect(postAgentOutput).toHaveBeenCalledWith(
      expect.objectContaining({ data: 'now' }),
    );
  });

  it('dropPtyOutput discards pending chunks without sending', async () => {
    const { reportPtyOutput, dropPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'lost');
    dropPtyOutput('t1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(postAgentOutput).not.toHaveBeenCalled();
  });

  it('does not buffer or send when reporting is disabled', async () => {
    vi.mocked(isVsqlCacheReportingEnabled).mockReturnValue(false);
    const { reportPtyOutput, flushPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'ignored');
    flushPtyOutput('t1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(postAgentOutput).not.toHaveBeenCalled();
  });

  it('does not log per-chunk warnings when postAgentOutput fails', async () => {
    vi.mocked(postAgentOutput).mockRejectedValue(new Error('backend down'));
    const { reportPtyOutput } = await loadReporter();

    reportPtyOutput('DotNetPert', 't1', 'a');
    reportPtyOutput('DotNetPert', 't1', 'b');
    await vi.advanceTimersByTimeAsync(150);

    // The reporter may aggregate drops, but it must not emit a warning for
    // every individual failed chunk.
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to report output'),
    );
  });
});
