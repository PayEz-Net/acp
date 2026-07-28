import { useEffect } from 'react';
import { useAgentOutputStore, markFrameBackedTerminal } from '../stores/agentOutputStore';
import { terminalStreamNormalizer, extractStatusFromFrameLine, type StreamLine } from '../lib/terminalStream';

/**
 * Subscribes to main-process screen-model frames (IPC 'terminal:frame') and
 * applies them to the output store:
 *   - history appends flow through the shared stream normalizer (thinking
 *     collapse, code-change cards, dedup — same treatment as the cloud path),
 *   - the live screen region is stored verbatim (replace semantics),
 *   - ED 3 scrollback clears wipe both the store history and the normalizer's
 *     per-terminal state so re-rendered history is not dedup-dropped,
 *   - footer lines inside the screen feed the agent-status store (frame-backed
 *     terminals skip the cloud SSE path, where this used to happen).
 *
 * Once a terminal is frame-backed, `useVsqlCacheSse` skips its cloud rows, so
 * local panes render the local model only — no cloud round-trip on the live
 * display path, and no duplicate content.
 */
export function useTerminalFrames(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.electronAPI?.onTerminalFrame) return;

    const unsubscribe = window.electronAPI.onTerminalFrame((frame) => {
      markFrameBackedTerminal(frame.terminalId);
      const store = useAgentOutputStore.getState();

      if (frame.historyCleared) {
        terminalStreamNormalizer.dropTerminal(frame.terminalId);
        store.clearTerminalHistory(frame.terminalId, frame.agentName);
      }

      if (frame.historyAppended.length > 0) {
        const ts = new Date().toISOString();
        const normalized: StreamLine[] = [];
        for (const text of frame.historyAppended) {
          const out = terminalStreamNormalizer.process({
            agent: frame.agentName,
            terminal_id: frame.terminalId,
            line: text,
            ts,
          });
          const deferred = terminalStreamNormalizer.drain();
          if (out) normalized.push(out);
          if (deferred) normalized.push(deferred);
        }
        if (normalized.length > 0) store.addLines(normalized);
      }

      store.setTerminalScreen(frame.terminalId, frame.screen);
      for (const line of frame.screen) {
        extractStatusFromFrameLine(frame.agentName, line);
      }
    });

    return unsubscribe;
  }, []);
}
