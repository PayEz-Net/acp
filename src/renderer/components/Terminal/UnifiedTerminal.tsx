/**
 * UnifiedTerminal — DOM-based terminal surface for per-agent terminal panes.
 *
 * Consumes the normalized `agentOutputStore` stream (ANSI stripped, provider
 * adapter applied, blanks and spinner frames collapsed) and renders it as a
 * scrollable line log. A single Vercel-style composer at the bottom of the pane
 * is the primary chat/input control.
 *
 * Performance notes:
 * - The visible line list is virtualized with @tanstack/react-virtual and
 *   dynamic row-height measurement so a 1,000-line scrollback only creates DOM
 *   nodes for the viewport plus overscan.
 * - Footer metadata (line count, thinking count, live-thinking state) is
 *   computed from a debounced snapshot so bursts of PTY output do not recompute
 *   derived state every frame.
 * - Auto-scroll uses requestAnimationFrame and only fires when the user is
 *   already near the bottom.
 * - Plain-text paste uses the browser's native `paste` event to avoid a
 *   blocking main-process clipboard round-trip.
 */

import { useEffect, useRef, useState, useCallback, useMemo, useId } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { ChevronDown, Send, X } from 'lucide-react';
import { useAgentOutputStore, type AgentOutputLine } from '../../stores/agentOutputStore';
import { useAppStore } from '../../stores/appStore';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentStatusStore } from '../../stores/agentStatusStore';
import { useAcpSessionStore, type StagedImageInput } from '../../stores/acpSessionStore';
import { ThinkingBlock } from '../ThinkingBlock';
import { TerminalFooter } from './TerminalFooter';
import { CodeChangeCard } from './CodeChangeCard';
import { terminalStreamNormalizer } from '../../lib/terminalStream';
import { useInputHistory } from '../../hooks/useInputHistory';

import { perfMark, perfMeasure } from '../../lib/perf';
import { trackEvent } from '../../lib/telemetry';
import { AcpTranscript } from '../AcpTranscript';

export interface UnifiedTerminalProps {
  /** Agent whose output stream to render. */
  agentName?: string;
  /** Full agent state (preferred). */
  agent?: import('@shared/types').AgentState;
  /** Active PTY terminal id for this agent. Undefined when the agent is offline. */
  terminalId?: string;
  /** Pane is the actively focused terminal. */
  isFocused?: boolean;
  /** Optional compact font size (sidebar mode). */
  compact?: boolean;
  /** Called when the user focuses the terminal surface or composer. */
  onFocus?: () => void;
  /** Called when the live-thinking state changes so the parent can sync status. */
  onThinkingLiveChange?: (isThinkingLive: boolean) => void;
}

export const MIN_COLS = 10;
export const MIN_ROWS = 4;

/**
 * A turn is running — detected STRUCTURALLY, not from spinner wording.
 *
 * `esc to interrupt` is only offered while there is something to interrupt, and
 * the spinner line always carries an elapsed/token counter regardless of which
 * adjective precedes it ("Brewed for 16s", "Crunching (1m 11s · ↓ 3.3k tokens)",
 * "Meandering", "Skedaddling"…). Matching the adjective list is unwinnable —
 * it is generated flavour text — so match the shape around it instead.
 */
const TURN_ACTIVE =
  /esc to interrupt|\((?:\d+m\s*)?\d+s(?:\s*·[^)]*)?\)|↓\s*[\d.]+k?\s*tokens/i;

/**
 * Provider status chrome: the permission-mode footer, the transcript-saving
 * warning, and the labelled separator rules. Classified as `info` so it dims
 * instead of competing with content at the same weight.
 *
 * Pattern-matching another product's UI is fragile — but the FAILURE MODE here
 * is "chrome goes bright again", never "content disappears". That is why this is
 * acceptable in the renderer while a filter that HID lines would not be. G4
 * removes the chrome at the source and this can go with it.
 */
const PROVIDER_CHROME =
  /^[\s│┃]*(?:[⏵▸]{2}|⚠\s|─{3,}|━{3,}|═{3,})|bypass permissions|Transcript saving is off|shift\+tab to cycle|esc to interrupt/i;

/**
 * Provider chrome that carries NO information and is therefore HIDDEN, not
 * merely dimmed: the TUI's own empty input box.
 *
 * We render our own composer ("Message <agent>…"), so the provider's prompt
 * gutter and the rules that frame it are duplicate furniture around a field
 * nobody types into. An empty box is not content, so dropping it cannot lose
 * anything — which is what separates this from filtering output, and why the
 * test is deliberately narrow:
 *   - a bare prompt marker with NOTHING after it
 *   - a rule made only of box-drawing (a LABELLED rule, e.g. "─ Debug ACP … ─",
 *     has letters and survives as dimmed `info`)
 * A prompt line WITH text is the user's own message and is rendered as a bubble
 * by the echo match above; it never reaches here.
 *
 * ⚠️ SHAPE MATTERS, not just meaning. The first draft of this was
 *   /^[\s│┃]*(?:[>›❯]\s*|[─━═_]{3,}[\s─━═_]*)$/
 * which took 5.3ms on a 2000-char non-matching line: `[─━═_]{3,}` and
 * `[\s─━═_]*` are two quantifiers over OVERLAPPING classes, so a long rule
 * followed by any non-match makes the engine try every split point. That is the
 * same catastrophic-backtracking bug that froze this app's UI for hours on
 * 2026-07-29, in this same file. Below, each alternative uses ONE quantifier and
 * no two quantifiers can claim the same character. Time any regex you add here
 * against long NON-MATCHING input — correctness tests pass on the broken form.
 */
const PROVIDER_EMPTY_CHROME = /^(?:[\s│┃]*[>›❯][\s]*|[\s│┃─━═_]{3,})$/;

/**
 * Named status furniture that is HIDDEN outright, by exact phrase.
 *
 * Dimming was not enough: it still occupies rows at the bottom of every pane
 * forever, and in a tool scanned at a glance a permanently-present block is a
 * permanent tax on the reader. None of it is information — it restates a
 * launch-time setting, a keybinding we already surface, and an env artifact.
 *
 * DELIBERATELY PHRASE-SPECIFIC, not `/^⚠/`. A blanket warning filter would also
 * swallow a REAL provider warning (rate limit, quota, degraded model), which is
 * exactly the content you most need to see. Each entry here is a known-constant
 * string; anything unrecognised stays visible and merely dims via
 * PROVIDER_CHROME. Add to this list only with a phrase you can point at.
 *
 * `esc to interrupt` is safe to hide because TURN_ACTIVE reads the UNFILTERED
 * frame — the header's live-state signal does not depend on the row being shown.
 */
const PROVIDER_NOISE =
  /bypass permissions|shift\+tab to cycle|Transcript saving is off|Debug ACP development environment startup/i;

/**
 * The ACP's own boot kickoff, injected into argv so the agent reads its system
 * prompt before any user message. It is machinery, not something the human said,
 * and rendering it as a prompt line implies the user typed it. Hidden.
 */
const BOOT_KICKOFF = /^[\s>›❯]*Begin\.\s*$/;

/**
 * Is this screen row the provider echoing back a message WE sent?
 *
 * Matched against text we actually wrote (exact), after stripping the prompt
 * gutter — not by sniffing for `›`, so a TUI restyle cannot break it.
 */
function isOwnEcho(line: string, sent: ReadonlySet<string>): boolean {
  const bare = line.replace(/^[\s>›❯$|┃│]+/, '').trim();
  return bare.length > 0 && sent.has(bare);
}

const SAMPLE_CHARS = 'MMMMMMMMMM';
const AUTO_SCROLL_THRESHOLD_PX = 40;
const FOOTER_DEBOUNCE_MS = 100;
const PASTE_COLLAPSE_LINE_THRESHOLD = 5;
const PASTE_COLLAPSE_CHAR_THRESHOLD = 1000;

/**
 * Transport-cost cap for pasted images, NOT a format gate: anything larger is
 * canvas-scaled down so we don't ship 20 MB of base64 over IPC+stdio.
 * Readability of the bytes IS gated locally — corrupt clipboard data that the
 * renderer cannot decode is rejected with a composer error rather than shipped
 * for the kimi server-side gate to silently drop (WO 11438).
 */
const MAX_TRANSPORT_EDGE_PX = 2000;

/** A pasted image staged above the composer, ready to ride the next prompt. */
export interface ComposerStagedImage {
  id: string;
  name: string;
  mimeType: string;
  /** Final send-ready data URL (after any transport re-encode/downscale). */
  dataUrl: string;
  /** Object URL of the original file, used only for the chip thumbnail. */
  previewUrl: string;
}

export interface TransportEncodedImage {
  dataUrl: string;
  mimeType: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read pasted image'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = src;
  });
}

/**
 * Transport conversion for a pasted image file. PNG ships as-is; anything
 * else is re-encoded to PNG via canvas; anything with a longest edge over
 * MAX_TRANSPORT_EDGE_PX is canvas-scaled first (transport cost only — the
 * server compresses anyway).
 *
 * Decode IS a gate: bytes the renderer cannot read or decode cannot be
 * previewed and are almost always corrupt clipboard data — shipping them raw
 * was the silent-loss vector (the server gate dropped them and the agent
 * received bare text, WO 11438). Throws on unreadable/undecodable bytes; the
 * caller surfaces a composer error. Only a canvas re-encode failure after a
 * successful decode still falls back to the original (provably valid) bytes.
 */
export async function encodeImageForTransport(file: File): Promise<TransportEncodedImage> {
  const rawDataUrl = await readFileAsDataUrl(file);
  const fallbackMimeType = file.type || 'image/png';

  const img = await loadImageElement(rawDataUrl);

  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const longestEdge = Math.max(width, height);
  const scale = longestEdge > MAX_TRANSPORT_EDGE_PX ? MAX_TRANSPORT_EDGE_PX / longestEdge : 1;
  if (file.type === 'image/png' && scale === 1) {
    return { dataUrl: rawDataUrl, mimeType: 'image/png' };
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: rawDataUrl, mimeType: fallbackMimeType };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/png'), mimeType: 'image/png' };
  } catch {
    return { dataUrl: rawDataUrl, mimeType: fallbackMimeType };
  }
}

/** RFC-4122 v4 UUID via crypto.getRandomValues (avoids crypto.randomUUID). */
function newStagedImageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Strip the `data:<mime>;base64,` prefix from a data URL for the wire. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * Boundary adaptation for the transcript store: ComposerStagedImage carries a
 * data URL while StagedImageInput wants an ArrayBuffer. Inverse of the store's
 * arrayBufferToBase64.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function UnifiedTerminal({
  agentName: agentNameProp,
  agent: agentProp,
  terminalId,
  isFocused,
  compact,
  onFocus,
  onThinkingLiveChange,
}: UnifiedTerminalProps) {
  const agent = agentProp ?? null;
  const agentName = agent?.name ?? agentNameProp ?? '';
  // Narrow selector: only subscribe to lines for this agent.
  const allLines = useAgentOutputStore((s) => s.lines);
  const filteredLines = useMemo(
    () => allLines.filter((l) => l.agent === agentName),
    [allLines, agentName],
  );
  // Live screen rows from the main-process screen model (frame-backed PTY
  // terminals only). Rendered after the normalized history; repaints replace
  // rows in place instead of appending, which is what makes resize redraws
  // and spinner ticks render correctly.
  const frameScreen = useAgentOutputStore((s) => (terminalId ? s.frames[terminalId] : undefined));
  // Live-turn detection that does NOT depend on the provider's spinner wording.
  // `THINKING_LABEL` in terminalStream matches thinking|analyzing|processing|…
  // while Claude says "Brewed", "Crunching", "Meandering", "Skedaddling",
  // "Ruminating" — so a busy pane read "Ready". That word list is unwinnable;
  // it is generated flavour text and changes.
  // These two markers are structural instead: `esc to interrupt` is only offered
  // while a turn can be interrupted, and the spinner always carries an
  // elapsed/token counter whatever adjective precedes it.
  const frameTurnActive = useMemo(
    () => !!frameScreen?.some((l) => TURN_ACTIVE.test(l)),
    [frameScreen],
  );
  // Text WE sent, so an echo of it in the screen model can be recognised as the
  // user's own words rather than agent output. Matching against what we actually
  // wrote is exact — it is not glyph-sniffing the provider's prompt marker, so a
  // TUI restyle cannot break it.
  const sentText = useMemo(() => {
    const seen = new Set<string>();
    for (const l of filteredLines) {
      if (l.source === 'user') {
        const t = l.line.trim();
        if (t) seen.add(t);
      }
    }
    return seen;
  }, [filteredLines]);
  const displayLines = useMemo<AgentOutputLine[]>(() => {
    if (!frameScreen || frameScreen.length === 0) return filteredLines;
    const screenLines: AgentOutputLine[] = frameScreen
      .filter(
        (line) =>
          !PROVIDER_EMPTY_CHROME.test(line) &&
          !PROVIDER_NOISE.test(line) &&
          !BOOT_KICKOFF.test(line),
      )
      .map((line, i) => {
      // Frame rows were unconditionally stamped 'agent', so the user's OWN
      // message — echoed back by the provider TUI — rendered identically to the
      // agent's, distinguished only by a leading chevron. A one-character glyph
      // is not an affordance: nobody should have to learn that `›` means "you".
      // Strip the provider's prompt marker and see if we sent this line.
      // The FRAME copy of a message we sent is the one in the right place —
      // it sits where you typed it, between the surrounding output. The store's
      // copy renders before the entire current screen (history precedes frame
      // rows), so it would appear stranded above unrelated output. So: style the
      // frame echo as the bubble, and drop the store's duplicate below.
      const own = isOwnEcho(line, sentText);
      return {
        id: `frame-${terminalId}-${i}`,
        agent: agentName,
        terminal_id: terminalId ?? '',
        // Strip the provider's prompt gutter — inside a bubble it is noise.
        line: own ? line.replace(/^[\s>›❯$|┃│]+/, '').trim() : line,
        ts: '',
        source: own
          ? ('user' as const)
          : PROVIDER_CHROME.test(line)
            ? ('info' as const)
            : ('agent' as const),
      };
    });
    // Drop the store's own copy of anything the screen model is already showing
    // as the user's line, or the message renders twice.
    // Drop the store's copy of anything the screen is already showing as ours,
    // or the message renders twice — once stranded in history, once in place.
    const shownAsOwn = new Set(
      screenLines.filter((l) => l.source === 'user').map((l) => l.line),
    );
    const history = shownAsOwn.size
      ? filteredLines.filter((l) => !(l.source === 'user' && shownAsOwn.has(l.line.trim())))
      : filteredLines;
    return [...history, ...screenLines];
  }, [filteredLines, frameScreen, agentName, terminalId, sentText]);
  const showThinking = useAppStore((s) => s.settings.showThinking) !== false;

  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pastedBlockRef = useRef<{ placeholder: string; fullText: string; start: number; end: number } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalIdRef = useRef(terminalId);
  const userScrolledRef = useRef(false);
  const rafScrollRef = useRef<number | null>(null);
  terminalIdRef.current = terminalId;

  const [paused, setPaused] = useState(false);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [interruptFlash, setInterruptFlash] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [stagedImages, setStagedImages] = useState<ComposerStagedImage[]>([]);
  const errorId = useId();

  // Synchronous source of truth for staged images: mutators update the ref
  // first and feed setState from it, so sendInputLine (which may run in a
  // microtask right after awaiting staging, before React re-renders) never
  // reads a stale list. Also used by the unmount cleanup to revoke object URLs.
  const stagedImagesRef = useRef<ComposerStagedImage[]>([]);
  // In-flight paste staging. sendInputLine awaits this so an Enter pressed
  // while a pasted image is still encoding can't silently send text-only.
  const pendingStagingRef = useRef<Promise<void> | null>(null);
  // One-shot read-failure latch: set by stageImages, consumed by sendInputLine
  // to block the next send with the error re-surfaced (WO 11438).
  const stagingErrorRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      for (const img of stagedImagesRef.current) {
        URL.revokeObjectURL(img.previewUrl);
      }
    };
  }, []);

  // Stage pasted image files (ACP mode only). Files whose bytes cannot be
  // read or decoded are NOT staged — the failure is surfaced as a composer
  // error and remembered in stagingErrorRef so the next Enter can't silently
  // send text-only (WO 11438).
  const stageImages = useCallback(async (files: File[]) => {
    const results = await Promise.all(
      files.map(async (file): Promise<ComposerStagedImage | null> => {
        const name = file.name || `pasted-image.${(file.type.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'}`;
        try {
          const encoded = await encodeImageForTransport(file);
          return {
            id: newStagedImageId(),
            name,
            mimeType: encoded.mimeType,
            dataUrl: encoded.dataUrl,
            previewUrl: URL.createObjectURL(file),
          };
        } catch {
          return null;
        }
      }),
    );
    const staged = results.filter((r): r is ComposerStagedImage => r != null);
    if (staged.length < files.length) {
      const failedNames = files
        .filter((_, i) => results[i] == null)
        .map((file, i) => file.name || `pasted image ${i + 1}`);
      stagingErrorRef.current =
        failedNames.length === 1
          ? `Couldn't read image "${failedNames[0]}" — copy it again and re-paste`
          : `Couldn't read ${failedNames.length} images — copy them again and re-paste`;
      setSendError(stagingErrorRef.current);
    } else {
      stagingErrorRef.current = null;
    }
    if (staged.length > 0) {
      const next = [...stagedImagesRef.current, ...staged];
      stagedImagesRef.current = next;
      setStagedImages(next);
    }
  }, []);

  const removeStagedImage = useCallback((id: string) => {
    const next = stagedImagesRef.current.filter((img) => {
      if (img.id === id) {
        URL.revokeObjectURL(img.previewUrl);
        return false;
      }
      return true;
    });
    stagedImagesRef.current = next;
    setStagedImages(next);
    inputRef.current?.focus();
  }, []);

  const clearStagedImages = useCallback(() => {
    for (const img of stagedImagesRef.current) {
      URL.revokeObjectURL(img.previewUrl);
    }
    stagedImagesRef.current = [];
    setStagedImages([]);
  }, []);

  // Debounced footer metadata so PTY bursts don't recompute stats every frame.
  // Initialize synchronously from the current lines so first render is correct.
  const computeStats = useCallback((lines: AgentOutputLine[]) => {
    const lineCount = lines.length;
    const thinkingCount = lines.filter((l) => l.thinking && !l.thinkingLive).length;
    const isThinkingLive = lines.length > 0 && !!lines[lines.length - 1].thinkingLive;
    return { lineCount, thinkingCount, isThinkingLive };
  }, []);

  const [debouncedStats, setDebouncedStats] = useState(() => computeStats(filteredLines));

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedStats(computeStats(filteredLines));
    }, FOOTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filteredLines, computeStats]);

  const { lineCount, thinkingCount, isThinkingLive } = debouncedStats;
  const activeProject = useProjectStore((s) => s.activeProject);
  const repoPath = activeProject?.repo_path ?? '';
  // runtime_choice is the single authority for the team runtime; agent.provider
  // may be stale from the legacy agentProvider field.
  const effectiveProvider = activeProject?.runtime_choice ?? agent?.provider ?? null;
  const agentStatus = useAgentStatusStore((s) => s.statuses[agentName]);
  const contextUsage = agentStatus?.contextUsage ?? 0;
  const acpSession = useAcpSessionStore((s) => s.sessions.get(agentName));
  // ACP transcript is authoritative once the session has been initialized
  // (sessionId assigned by the runtime). Until then, fall back to the PTY/bridge
  // surface so the pane never shows a stale or mixed stream.
  const isAcpMode = !!acpSession?.sessionId;
  const sessionKey = isAcpMode ? (acpSession?.sessionId ?? '') : (terminalId ?? '');
  const inputHistory = useInputHistory(agentName, sessionKey || undefined);

  const acpActiveTurn = isAcpMode
    ? (acpSession?.turns.find((t) => t.id === acpSession?.activeTurnId) ?? null)
    : null;
  const acpIsThinkingLive = acpActiveTurn?.status === 'thinking';
  const footerLineCount = isAcpMode ? (acpSession?.turns.length ?? 0) : lineCount;
  const footerThinkingCount = isAcpMode ? 0 : thinkingCount;

  const computeDimensions = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    const scroll = scrollRef.current;
    if (!container || !measure || !scroll) return { cols: MIN_COLS, rows: MIN_ROWS };

    const rect = measure.getBoundingClientRect();
    const charWidth = rect.width / SAMPLE_CHARS.length;
    const lineHeight = rect.height;
    if (charWidth <= 0 || lineHeight <= 0) return { cols: MIN_COLS, rows: MIN_ROWS };

    // Measure the scroll surface (the actual text box), not the outer host.
    // clientWidth includes padding but excludes the scrollbar; subtract the
    // padding to get the content box the PTY should format for. This keeps the
    // reported cols/rows in sync with where the DOM will wrap, avoiding the
    // "resize is hard" mismatch where the CLI emitted more cols than fit.
    const style = window.getComputedStyle(scroll);
    const paddingHor = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const paddingVer = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);

    const availableWidth = Math.max(0, scroll.clientWidth - paddingHor);
    const availableHeight = Math.max(0, scroll.clientHeight - paddingVer);

    const cols = Math.max(MIN_COLS, Math.floor(availableWidth / charWidth));
    const rows = Math.max(MIN_ROWS, Math.floor(availableHeight / lineHeight));

    return { cols, rows };
  }, []);

  const reportDimensions = useCallback(() => {
    const dims = computeDimensions();
    const tid = terminalIdRef.current;
    if (tid && typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.resizeTerminal(tid, dims.cols, dims.rows);
    }
  }, [computeDimensions]);

  // Debounced resize reporting.
  const scheduleReport = useCallback(() => {
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      reportDimensions();
    }, 100);
  }, [reportDimensions]);

  useEffect(() => {
    const observer = new ResizeObserver(scheduleReport);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    // Initial report after layout settles.
    let rafHandle: number;
    rafHandle = requestAnimationFrame(() => {
      rafHandle = requestAnimationFrame(() => {
        reportDimensions();
      });
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafHandle);
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [scheduleReport, reportDimensions]);

  // Re-report dimensions when a new terminal session starts.
  useEffect(() => {
    if (terminalId) {
      const t = setTimeout(() => reportDimensions(), 0);
      return () => clearTimeout(t);
    }
  }, [terminalId, reportDimensions]);

  // Virtualize the line list. Dynamic row heights handle wrapped lines.
  const virtualizer = useVirtualizer({
    count: displayLines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 5,
    getItemKey: (index) => displayLines[index]?.id ?? `fallback-${index}`,
  });

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Determine whether the user is currently near the bottom.
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
  }, []);

  // Auto-scroll to bottom when new lines arrive, unless paused or user scrolled up.
  useEffect(() => {
    if (paused) {
      setShowNewOutput(true);
      return;
    }
    if (rafScrollRef.current) cancelAnimationFrame(rafScrollRef.current);
    rafScrollRef.current = requestAnimationFrame(() => {
      rafScrollRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const nearBottom = userScrolledRef.current ? isNearBottom() : true;
      if (nearBottom) {
        virtualizer.scrollToIndex(displayLines.length - 1, { align: 'end', behavior: 'auto' });
        setShowNewOutput(false);
        userScrolledRef.current = false;
      } else {
        setShowNewOutput(true);
      }
    });
    return () => {
      if (rafScrollRef.current) {
        cancelAnimationFrame(rafScrollRef.current);
        rafScrollRef.current = null;
      }
    };
  }, [displayLines.length, paused, virtualizer, isNearBottom]);

  // Track scroll position to pause/resume automatically.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    userScrolledRef.current = true;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD_PX;
    if (nearBottom && paused) {
      setPaused(false);
      setShowNewOutput(false);
    } else if (!nearBottom && !paused) {
      setPaused(true);
    }
  }, [paused]);

  // Focus the composer when this pane becomes focused.
  useEffect(() => {
    if (isFocused) {
      inputRef.current?.focus();
    }
  }, [isFocused]);

  // Notify the parent when live-thinking state changes so the header status
  // pill can stay in sync with the footer. In ACP mode the authority is the
  // active turn status, not the PTY line stream.
  useEffect(() => {
    // OR in the structural frame signal: the stream classifier misses Claude's
    // spinner wording entirely, so without this a busy pane reports "Ready".
    onThinkingLiveChange?.(
      isAcpMode ? acpIsThinkingLive : isThinkingLive || frameTurnActive,
    );
  }, [isAcpMode, acpIsThinkingLive, isThinkingLive, frameTurnActive, onThinkingLiveChange]);

  // Clear the Escape-interrupt flash after a short delay so it acts as a
  // transient confirmation rather than persistent state.
  useEffect(() => {
    if (!interruptFlash) return;
    const timer = setTimeout(() => setInterruptFlash(null), 2000);
    return () => clearTimeout(timer);
  }, [interruptFlash]);

  // Hide the ACP "Stopping…" indicator once the active turn actually stops.
  useEffect(() => {
    if (!cancelRequested) return;
    if (
      !acpActiveTurn ||
      acpActiveTurn.status === 'done' ||
      acpActiveTurn.status === 'error'
    ) {
      setCancelRequested(false);
    }
  }, [cancelRequested, acpActiveTurn]);

  const getSelectionText = useCallback((): string => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    return selection.toString();
  }, []);

  const handleCopy = useCallback(() => {
    const text = getSelectionText();
    if (text) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }, [getSelectionText]);

  const writePastedText = useCallback(async (text: string) => {
    const tid = terminalIdRef.current;
    if (!tid || !text) return;
    const start = perfMark('terminal-paste');
    window.electronAPI.writeTerminal(tid, text);
    perfMeasure('terminal-paste', start, { length: text.length });
  }, []);

  // Native paste path for the terminal surface — avoids the main-process
  // clipboard round-trip on the critical input path.
  const handleTerminalPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (e.defaultPrevented) return;
      // Only handle pastes that actually landed on the scroll surface or its
      // children. Events from the composer input must not be rerouted to the
      // PTY (where ACP sessions silently no-op).
      const target = e.target as Node | null;
      if (!target || !scrollRef.current || !scrollRef.current.contains(target)) return;
      const tid = terminalIdRef.current;
      if (!tid) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (text) {
        e.preventDefault();
        writePastedText(text);
      }
    },
    [writePastedText],
  );

  // Fallback paste path used by the context-menu handler.
  const handlePasteFallback = useCallback(async () => {
    const tid = terminalIdRef.current;
    if (!tid) return;
    try {
      const text = await window.electronAPI.readClipboardText();
      if (text) {
        writePastedText(text);
      }
    } catch (err) {
      console.warn(`[UnifiedTerminal ${agentName}] paste fallback failed:`, err);
    }
  }, [agentName, writePastedText]);

  const handleContextMenuPaste = useCallback(async () => {
    // Prefer the native paste path so clipboard text lands in the composer
    // input exactly like Ctrl+V. Focus the input first so webContents.paste()
    // targets it.
    inputRef.current?.focus();
    try {
      await window.electronAPI.triggerPaste();
    } catch (err) {
      console.warn(`[UnifiedTerminal ${agentName}] context-menu paste failed:`, err);
      // Fallback for plain text: read the OS clipboard and write it to the PTY.
      await handlePasteFallback();
    }
  }, [agentName, handlePasteFallback]);

  // Find the exact position of the collapsed-paste placeholder in the current
  // input value. Returns null if it is missing or appears more than once.
  const findBlockRange = useCallback((input: HTMLInputElement) => {
    const block = pastedBlockRef.current;
    if (!block) return null;
    const start = input.value.indexOf(block.placeholder);
    if (start === -1) return null;
    if (input.value.indexOf(block.placeholder, start + 1) !== -1) return null;
    return { start, end: start + block.placeholder.length };
  }, []);

  // Recompute the cached start/end for the collapsed block. Clears the block if
  // the placeholder is no longer present exactly once.
  const refreshBlockRange = useCallback(
    (input: HTMLInputElement) => {
      const range = findBlockRange(input);
      if (!range || !pastedBlockRef.current) {
        pastedBlockRef.current = null;
        return null;
      }
      pastedBlockRef.current = { ...pastedBlockRef.current, ...range };
      return range;
    },
    [findBlockRange],
  );

  // Remove the collapsed block from the input while preserving any typed text
  // before or after it. The cursor is placed where the block started.
  const removeBlock = useCallback(
    (input: HTMLInputElement) => {
      const range = findBlockRange(input);
      if (!range) {
        pastedBlockRef.current = null;
        return;
      }
      const before = input.value.slice(0, range.start);
      const after = input.value.slice(range.end);
      input.value = before + after;
      pastedBlockRef.current = null;
      input.setSelectionRange(range.start, range.start);
    },
    [findBlockRange],
  );

  const insertTextAtCursor = useCallback(
    (input: HTMLInputElement, text: string) => {
      let start = input.selectionStart ?? input.value.length;
      let end = input.selectionEnd ?? input.value.length;
      const lineCount = text.split('\n').length;
      const shouldCollapse =
        lineCount >= PASTE_COLLAPSE_LINE_THRESHOLD || text.length >= PASTE_COLLAPSE_CHAR_THRESHOLD;

      const mark = perfMark('composer-insert-text');

      if (shouldCollapse) {
        // Large code/text pastes get collapsed into a placeholder so the single-line
        // composer doesn't render hundreds of lines. The full text is preserved and
        // sent as the actual message when the user hits Enter.
        const placeholder = `[pasted code ${lineCount} lines]`;
        // Keep only one collapsed block at a time. If one already exists, remove it
        // before inserting the new one so we never end up with two placeholders.
        if (pastedBlockRef.current) {
          removeBlock(input);
          start = input.selectionStart ?? input.value.length;
          end = input.selectionEnd ?? input.value.length;
        }
        pastedBlockRef.current = { placeholder, fullText: text, start, end: start + placeholder.length };
        input.setRangeText(placeholder, start, end, 'end');
      } else if (typeof input.setRangeText === 'function') {
        // Use the native setRangeText API when available: it performs the splice
        // and selection update in one optimized browser operation, avoiding the
        // O(n) string copies that happen when we slice and concatenate manually.
        // This makes pasting small-to-medium prompts into the composer feel instant.
        input.setRangeText(text, start, end, 'end');
        // A small paste that overlaps the placeholder corrupts the block; clear it.
        if (pastedBlockRef.current) {
          refreshBlockRange(input);
        }
      } else {
        const newValue = input.value.slice(0, start) + text + input.value.slice(end);
        input.value = newValue;
        const newCursor = start + text.length;
        input.setSelectionRange(newCursor, newCursor);
        if (pastedBlockRef.current) {
          refreshBlockRange(input);
        }
      }

      input.focus();
      perfMeasure('composer-insert-text', mark, {
        length: text.length,
        collapsed: shouldCollapse,
        combined: shouldCollapse,
      });
    },
    [removeBlock, refreshBlockRange],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const selection = getSelectionText();
      const items: { label: string; action: () => void }[] = [];
      if (selection) {
        items.push({ label: 'Copy', action: handleCopy });
      }
      if (terminalIdRef.current) {
        items.push({ label: 'Paste', action: handleContextMenuPaste });
      }
      if (items.length === 0) return;

      const menu = document.createElement('div');
      menu.className =
        'fixed z-50 bg-slate-800 border border-slate-700 rounded shadow-lg py-1 text-xs text-slate-200';
      menu.style.left = `${e.clientX}px`;
      menu.style.top = `${e.clientY}px`;
      items.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'block w-full text-left px-3 py-1 hover:bg-slate-700';
        btn.textContent = item.label;
        btn.onclick = () => {
          item.action();
          if (menu.parentNode) document.body.removeChild(menu);
        };
        menu.appendChild(btn);
      });
      document.body.appendChild(menu);
      requestAnimationFrame(() => {
        document.addEventListener('click', () => {
          if (menu.parentNode) document.body.removeChild(menu);
        }, { once: true });
      });
    },
    [handleCopy, handleContextMenuPaste, getSelectionText],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isAcpMode) return;
      const tid = terminalIdRef.current;
      if (!tid) return;

      // Ctrl+C: copy if there is a selection, otherwise send SIGINT.
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        const selection = getSelectionText();
        if (selection) {
          e.preventDefault();
          handleCopy();
        } else {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u0003');
        }
        return;
      }

      // Ctrl+V is now handled by the native paste event on the scroll surface.

      // Forward a few useful control sequences.
      if (e.key.length > 1) {
        if (e.key === 'Enter') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\r');
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u007f');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\t');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\u001b');
        }
        return;
      }

      // Printable keystrokes.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        window.electronAPI.writeTerminal(tid, e.key);
      }
    },
    [getSelectionText, handleCopy, isAcpMode],
  );

  // Human interrupt (WO 11635, Claude-Code-parity): HALT FAST — cancel the
  // in-flight turn immediately. The queue is PRESERVED, never purged: the
  // agent reads everything the human typed (in order), attends to it, then
  // resumes the prior work in order. Purge does not exist on the human path.
  // Idle guard (QAPert 11611): with no turn in flight there is nothing to
  // cancel. Returns whether an interrupt actually fired.
  const interruptActiveTurn = useCallback((): boolean => {
    const activeTurnId = useAcpSessionStore.getState().getSession(agentName)?.activeTurnId;
    if (!activeTurnId) return false;
    const sessionId = acpSession?.sessionId ?? '';
    setCancelRequested(true);
    window.electronAPI.sendAcpCancel({ agent: agentName, sessionId });
    setInterruptFlash('Interrupted — stopping current turn…');
    return true;
  }, [acpSession?.sessionId, agentName]);

  const sendInputLine = useCallback(async () => {
    const tid = terminalIdRef.current;
    const input = inputRef.current;
    if (!input) return;
    // If the composer is showing a valid collapsed paste placeholder, combine
    // any typed prompt text with the stored full paste. Use a blank line to
    // separate the prompt from the code when both are present.
    let value = input.value;
    let combined = false;
    const block = pastedBlockRef.current;
    if (block) {
      const range = findBlockRange(input);
      const fullText = block.fullText;
      if (range) {
        const before = input.value.slice(0, range.start);
        const after = input.value.slice(range.end);
        const prompt = (before + after).trim();
        value = prompt ? `${prompt}\n\n${fullText}` : fullText;
        combined = prompt.length > 0;
      }
      pastedBlockRef.current = null;
    }
    setSendError(null);

    // Telemetry: flag sends that combine a typed prompt with a collapsed paste.
    if (block) {
      trackEvent({ event: 'composer_send', combined });
    }

    // /btw — a discoverable "by the way" side-remark. A message sent mid-turn is
    // already STEERED into the running turn by the adapter (WO 11585 Slice B), so
    // this never interrupts and never needs Esc. The framing tells the agent to
    // treat it as a side-note, not a new top-level task — and, crucially, gives
    // the human an explicit, named way to say "just a heads-up, keep going"
    // instead of guessing whether a plain message will steer or halt. Empty
    // `/btw` falls through unchanged. (Jon 2026-08-05)
    {
      const btwMatch = value.match(/^\s*\/btw\b[ \t]*/i);
      if (btwMatch) {
        const remark = value.slice(btwMatch[0].length).trim();
        if (remark) value = `[by the way — a side remark, not a new task; keep going and just factor this in] ${remark}`;
      }
    }

    if (isAcpMode) {
      // A bare interrupt typed mid-turn interrupts (WO 11635): the turn
      // cancels immediately; the queue is PRESERVED and read afterward.
      // Nothing queues silently.
      if (acpActiveTurn && isInterruptText(value)) {
        interruptActiveTurn();
        input.value = '';
        pastedBlockRef.current = null;
        return;
      }

      // A paste may still be encoding (FileReader + canvas are async). Wait for
      // in-flight staging so a quick Enter can't silently send text-only
      // without the image (WO 11438).
      const pending = pendingStagingRef.current;
      if (pending) {
        await pending.catch(() => {});
      }
      const staged = stagedImagesRef.current;

      // A paste that failed to read must not become a silent text-only send:
      // re-surface the error and swallow this Enter. The next Enter sends the
      // text deliberately.
      if (stagingErrorRef.current) {
        const message = stagingErrorRef.current;
        stagingErrorRef.current = null;
        setSendError(message);
        return;
      }

      // image_in UX gate (WO §3, refuse-with-message): when the active model's
      // catalog entry explicitly says no image input, refuse locally instead
      // of letting kimi silently degrade the images to "[image omitted]"
      // markers. Unknown/absent imageIn allows the send — the server gate is
      // the backstop for older runtimes.
      if (staged.length > 0 && acpSession?.imageIn === false) {
        setSendError("Current model can't see images");
        return;
      }

      setCancelRequested(false);

      const sessionId = acpSession?.sessionId ?? '';
      if (!value && staged.length === 0) return;

      // Slice B (WO 11585): a message sent while a turn is in flight is
      // STEERED into the running turn by the adapter — model-side continuity
      // is untouched. But VISUALLY the streaming assistant block must seal
      // here: chunks that arrive after the human's message belong BELOW it,
      // otherwise the pane shows the answer above the question (Jon's
      // report). stopActiveTurn closes the block cleanly (spinners stopped,
      // stopReason marks the seam); post-question output lands in a fresh
      // assistant turn under the question.
      const hasActiveTurn = !!useAcpSessionStore.getState().getSession(agentName)?.activeTurnId;
      if (hasActiveTurn) {
        useAcpSessionStore.getState().stopActiveTurn(agentName, 'continued below');
      }

      const storeImages: StagedImageInput[] = staged.map((img) => ({
        id: img.id,
        name: img.name,
        type: img.mimeType,
        data: base64ToArrayBuffer(stripDataUrlPrefix(img.dataUrl)),
      }));
      useAcpSessionStore.getState().startUserTurn(agentName, sessionId, value, storeImages);
      useAcpSessionStore.getState().startAssistantTurn(agentName, sessionId);

      // Wire payload carries base64 without the data-URL prefix, matching the
      // adapter's { type: 'image', data, mimeType } content-block contract.
      const wireImages = staged.map((img) => ({
        data: stripDataUrlPrefix(img.dataUrl),
        mimeType: img.mimeType,
        name: img.name,
      }));
      console.log(`[UnifiedTerminal ${agentName}] sending ACP prompt (session=${sessionId}, images=${wireImages.length}): ${value.slice(0, 80)}`);
      window.electronAPI
        .sendAcpPrompt({
          agent: agentName,
          sessionId,
          text: value,
          images: wireImages.length > 0 ? wireImages : undefined,
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Failed to send message.';
          setSendError(message);
          useAcpSessionStore.getState().failActiveTurn(agentName, message);
        });
      if (value) inputHistory.commit(value);
      input.value = '';
      clearStagedImages();
      return;
    }

    if (!tid) return;

    if (!value) return;
    const ts = new Date().toISOString();
    useAgentOutputStore.getState().addLine({ agent: agentName, terminal_id: tid, line: value, source: 'user', ts });
    terminalStreamNormalizer.suppressEcho(tid, value);
    window.electronAPI.writeTerminal(tid, value + '\r');
    inputHistory.commit(value);
    input.value = '';
  }, [isAcpMode, acpSession, agentName, inputHistory, findBlockRange, setCancelRequested, clearStagedImages, interruptActiveTurn]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const tid = terminalIdRef.current;
      const input = e.currentTarget;

      if (e.key === 'Enter') {
        e.preventDefault();
        sendInputLine();
        return;
      }

      // Ctrl+S (native kimi-code parity, WO 11647): flush the current input
      // into the running turn as steer — the "listen to me NOW" key, mashable.
      // Guarded like native: no-op when no turn is streaming; steer-flushed
      // input is cleared from the composer. Esc stays the halt; Ctrl+S is the
      // distinct attend key.
      if (e.key.toLowerCase() === 's' && e.ctrlKey && !e.metaKey && !e.altKey) {
        if (isAcpMode && acpActiveTurn) {
          e.preventDefault();
          sendInputLine();
        }
        return;
      }

      // Arrow keys: jump over the collapsed block instead of landing inside it.
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const block = pastedBlockRef.current;
        if (block) {
          const range = findBlockRange(input);
          if (range) {
            const caret = input.selectionStart ?? 0;
            if (e.key === 'ArrowLeft' && caret > range.start && caret <= range.end) {
              e.preventDefault();
              input.setSelectionRange(range.start, range.start);
              return;
            }
            if (e.key === 'ArrowRight' && caret >= range.start && caret < range.end) {
              e.preventDefault();
              input.setSelectionRange(range.end, range.end);
              return;
            }
          }
        }
        // Let the default arrow-key caret movement run when no jump is needed.
        return;
      }

      // Backspace/Delete removes the whole collapsed block when the caret is at
      // either boundary. If the caret is inside the placeholder, jump to the
      // nearest boundary instead of editing the placeholder characters.
      if (e.key === 'Backspace' || e.key === 'Delete') {
        const block = pastedBlockRef.current;
        if (block) {
          const range = findBlockRange(input);
          if (range) {
            const caret = input.selectionStart ?? 0;
            const atBoundary = caret === range.start || caret === range.end;
            const inside = caret > range.start && caret < range.end;
            if (atBoundary || inside) {
              e.preventDefault();
              removeBlock(input);
              return;
            }
          }
        }
        // Let the default editing behavior run when no block is active.
        return;
      }

      // History recall clears the collapsed block so the stored full text doesn't
      // override the recalled item on send. Typed text around the block is kept
      // as the history draft.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (pastedBlockRef.current) {
          console.warn('[UnifiedTerminal] clearing collapsed paste block on history recall');
          removeBlock(input);
        }
        const next = inputHistory.cycle(e.key === 'ArrowUp' ? 'up' : 'down', input.value);
        if (next !== null) {
          input.value = next;
          requestAnimationFrame(() => {
            input.setSelectionRange(next.length, next.length);
          });
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (pastedBlockRef.current) {
          removeBlock(input);
        } else if (isAcpMode) {
          // Escape interrupts (WO 11635): cancel immediately, queue
          // preserved. The flash lives inside interruptActiveTurn and only
          // fires when a turn actually died (idle Escape just clears input).
          interruptActiveTurn();
          input.value = '';
          pastedBlockRef.current = null;
        } else if (tid) {
          if (effectiveProvider === 'kimi') {
            window.electronAPI.writeTerminal(tid, '\u0003');
            setInterruptFlash('Interrupted — stopping current turn…');
          } else {
            window.electronAPI.writeTerminal(tid, '\u001b');
          }
        }
        return;
      }

      if (e.key === 'Tab') {
        if (!isAcpMode && tid) {
          e.preventDefault();
          window.electronAPI.writeTerminal(tid, '\t');
        }
        return;
      }

      // Ctrl+C: SIGINT if no selection, otherwise let default copy handle it.
      if (e.key.toLowerCase() === 'c' && (e.ctrlKey || e.metaKey)) {
        if (input.selectionStart === input.selectionEnd) {
          e.preventDefault();
          if (isAcpMode) {
            // Ctrl+C interrupts (WO 11635): cancel immediately, queue preserved.
            interruptActiveTurn();
          } else if (tid) {
            window.electronAPI.writeTerminal(tid, '\u0003');
          }
          input.value = '';
          pastedBlockRef.current = null;
        }
        return;
      }

      // Printable keystrokes inside the placeholder jump to the nearest boundary
      // so the user never edits the placeholder characters directly.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const block = pastedBlockRef.current;
        if (block) {
          const range = findBlockRange(input);
          if (range) {
            const caret = input.selectionStart ?? 0;
            if (caret > range.start && caret < range.end) {
              e.preventDefault();
              const target = caret - range.start < range.end - caret ? range.start : range.end;
              input.setSelectionRange(target, target);
            }
          }
        }
      }
    },
    [sendInputLine, findBlockRange, removeBlock, isAcpMode, acpSession, agentName, inputHistory, effectiveProvider, interruptActiveTurn],
  );

  const handleInputPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const items = Array.from(e.clipboardData?.items ?? []);
      let textHandled = false;
      const pasteMark = perfMark('composer-paste');

      // Insert plain text first so the composer stays responsive.
      // Prefer the synchronous getData API for the common case; only fall back
      // to the callback-based items API when getData is empty.
      const plainText = e.clipboardData?.getData('text/plain') ?? '';
      if (plainText) {
        textHandled = true;
        insertTextAtCursor(input, plainText);
      } else {
        for (const item of items) {
          if (item.kind === 'string' && item.type === 'text/plain') {
            textHandled = true;
            item.getAsString((text) => {
              insertTextAtCursor(input, text);
            });
          }
        }
      }

      // Image staging (ACP mode only — PTY sessions have no image transport).
      // Clipboard items are only valid during the event, so collect the Files
      // synchronously and encode/stage them async. A clipboard can carry both
      // text and image items; text semantics above are untouched.
      const imageFiles = isAcpMode
        ? items
            .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
            .map((item) => item.getAsFile())
            .filter((file): file is File => file != null)
        : [];

      if (textHandled || imageFiles.length > 0) {
        e.preventDefault();
        e.stopPropagation();
      }

      perfMeasure('composer-paste', pasteMark, {
        text: textHandled,
        images: imageFiles.length,
        length: input.value.length,
      });

      if (imageFiles.length > 0) {
        const pending = stageImages(imageFiles);
        pendingStagingRef.current = pending;
        try {
          await pending;
        } finally {
          if (pendingStagingRef.current === pending) pendingStagingRef.current = null;
        }
      }
    },
    [insertTextAtCursor, isAcpMode, stageImages],
  );

  const handleClick = useCallback(() => {
    onFocus?.();
    // Don't steal focus while the user is selecting text to copy.
    const selection = window.getSelection();
    if (!selection || selection.toString().length === 0) {
      inputRef.current?.focus();
    }
  }, [onFocus]);

  const handleInputInput = useCallback(
    (e: React.FormEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      if (pastedBlockRef.current) {
        refreshBlockRange(input);
      }
    },
    [refreshBlockRange],
  );

  const resumeFollow = useCallback(() => {
    setPaused(false);
    setShowNewOutput(false);
    userScrolledRef.current = false;
    // Scroll the actual scroll container to the bottom. This works for both
    // the PTY virtualized list and the ACP transcript, whereas
    // virtualizer.scrollToIndex only targets the PTY line list and does
    // nothing when the ACP transcript is rendered.
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div
        ref={containerRef}
        data-testid="terminal-host"
        className="relative flex-1 min-h-0 overflow-hidden bg-acp-bg"
        onClick={handleClick}
      >
        {/* Hidden measurement span for dimension math. */}
        <span
          ref={measureRef}
          data-testid="terminal-measure"
          aria-hidden="true"
          className={`absolute -left-[9999px] top-0 font-terminal whitespace-pre pointer-events-none select-none ${
            // MUST stay byte-identical to the content span's size/leading below.
            // This is the off-screen char-width measurer that feeds the PTY
            // resize; a mismatch computes the wrong `cols` and reintroduces the
            // wrapping mess. Change both or neither.
            compact ? 'text-[13px] leading-normal' : 'text-[15px] leading-normal'
          }`}
        >
          {SAMPLE_CHARS}
        </span>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onContextMenu={handleContextMenu}
          onKeyDown={handleKeyDown}
          onPaste={handleTerminalPaste}
          // overflow-x-HIDDEN for both modes. PTY panes used to scroll
          // horizontally, which is unusable: nobody scrolls sideways to read a
          // transcript, and a line that runs off the right edge is a line you
          // did not read. Lines already carry `whitespace-pre-wrap` + wrapping,
          // so hiding the axis makes them wrap instead of hide. Kimi panes have
          // always done this; there was no reason claude should not.
          className={`h-full w-full overflow-y-auto overflow-x-hidden outline-none focus:ring-1 focus:ring-inset focus:ring-emerald-500/50 font-terminal ${
            // Paired with the measurer span above — keep sizes identical.
            compact ? 'text-[13px]' : 'text-[15px]'
          } p-2`}
          role="log"
          aria-live="polite"
          aria-label={`Terminal output for ${agentName}`}
          tabIndex={0}
        >
          {isAcpMode ? (
            <>
              {acpSession?.spawnCommand && (
                <div
                  data-testid="spawn-command"
                  className="mb-2 select-text whitespace-pre-wrap break-all text-acp-text-muted/60"
                  title="Exact command this agent runtime was launched with"
                >
                  $ {acpSession.spawnCommand}
                </div>
              )}
              <AcpTranscript
                turns={acpSession?.turns ?? []}
                activeTurnId={acpSession?.activeTurnId ?? null}
                agent={agentName}
                sessionId={acpSession?.sessionId}
                pendingPermission={acpSession?.pendingPermission}
                cancelRequested={cancelRequested}
              />
            </>
          ) : (
            <>
              {filteredLines.length === 0 && !terminalId && (
                <div className="h-full flex items-center justify-center text-slate-500 select-none">
                  Terminal output will appear here.
                </div>
              )}

              {displayLines.length > 0 && (
                <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
                  {virtualItems.map((virtualItem) => {
                    const line = displayLines[virtualItem.index];
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                      >
                        <TerminalLine
                          line={line}
                          compact={compact}
                          showThinking={showThinking}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {showNewOutput && paused && (
          <button
            onClick={resumeFollow}
            className="absolute bottom-4 right-4 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 shadow-lg cursor-pointer"
          >
            <ChevronDown className="w-3.5 h-3.5" />
            New output
          </button>
        )}

        {!terminalId && filteredLines.length > 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-slate-500 select-none bg-slate-900/80">
            Session ended.
          </div>
        )}
      </div>

      {/* Footer context bar — metadata above the input */}
      {agent && (
        <TerminalFooter
          agent={agent}
          provider={effectiveProvider}
          repoPath={repoPath}
          lineCount={footerLineCount}
          thinkingCount={footerThinkingCount}
          contextUsage={contextUsage}
        />
      )}

      {/* Vercel-style composer — single chat input for the pane */}
      <div className="shrink-0 border-t border-slate-800 bg-slate-900 p-2 space-y-2">
        {/* Escape-interrupt confirmation flash */}
        {interruptFlash && (
          <div
            className="text-xs text-amber-400 px-1 flex items-center gap-1.5"
            data-testid="terminal-interrupt-flash"
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
            {interruptFlash}
          </div>
        )}

        {/* Validation / send errors */}
        {sendError && (
          <div
            id={errorId}
            className="text-xs text-red-400 px-1"
            data-testid="terminal-image-error"
          >
            {sendError}
          </div>
        )}

        {/* Staged pasted images — removable thumbnails riding the next prompt */}
        {stagedImages.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1" data-testid="staged-images">
            {stagedImages.map((img) => (
              <div
                key={img.id}
                data-testid="staged-image-chip"
                className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800/80 px-1.5 py-1"
              >
                <img
                  src={img.previewUrl}
                  alt={img.name}
                  className="h-16 w-auto max-w-40 shrink-0 rounded object-contain bg-slate-900/60"
                />
                <span className="max-w-[120px] truncate text-xs text-slate-300">{img.name}</span>
                <button
                  type="button"
                  onClick={() => removeStagedImage(img.id)}
                  className="p-0.5 rounded text-slate-400 hover:text-red-400 hover:bg-slate-700/50 transition-colors"
                  title={`Remove ${img.name}`}
                  aria-label={`Remove ${img.name}`}
                  data-testid="staged-image-remove"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 rounded-full bg-slate-800/80 px-3 py-2 border border-slate-700/50 focus-within:border-slate-500 focus-within:ring-1 focus-within:ring-slate-500/30 transition-all">
          <input
            ref={inputRef}
            type="text"
            defaultValue=""
            onKeyDown={handleInputKeyDown}
            onInput={handleInputInput}
            onPaste={handleInputPaste}
            onFocus={onFocus}
            disabled={!terminalId}
            placeholder={terminalId ? `Message ${agentName}…   ·   /btw for a side-note (no interrupt)` : 'Start the agent to type…'}
            className="flex-1 bg-transparent text-slate-200 text-sm font-sans placeholder:text-slate-500 outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="terminal-input"
            aria-label="Terminal message input"
            aria-describedby={sendError ? errorId : undefined}
          />
          <button
            onClick={sendInputLine}
            disabled={!terminalId}
            className="p-1.5 rounded-full text-slate-400 hover:text-emerald-400 hover:bg-slate-700/50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Send"
            data-testid="terminal-send"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

interface TerminalLineProps {
  line: AgentOutputLine;
  compact?: boolean;
  showThinking: boolean;
}

const LIST_MARKER = /^(\s*)(?:[•\-*]|\d{1,2}\.)\s/;

/** Bare interrupt words a human types to halt an in-flight turn (WO 11569). */
const INTERRUPT_WORDS = new Set(['stop', 'wait', 'cancel', 'hold on']);

/**
 * True when the text is exactly an interrupt word (case/punctuation-insensitive)
 * — the human's "stop" must trigger the cancel path, never queue silently.
 */
export function isInterruptText(value: string): boolean {
  return INTERRUPT_WORDS.has(value.trim().toLowerCase().replace(/[.!\s]+$/, ''));
}

function TerminalLine({ line, compact, showThinking }: TerminalLineProps) {
  // Live thinking placeholders are updated in-place by the store and
  // surfaced as a single-line indicator in the footer. They do not render as
  // repeated blocks inside the stream.
  if (line.thinkingLive) {
    return null;
  }
  if (line.codeChange) {
    return (
      <div className="px-1 -mx-1 py-0.5">
        <CodeChangeCard codeChange={line.codeChange} compact={compact} />
      </div>
    );
  }
  const isUser = line.source === 'user';
  const isInfo = line.source === 'info';
  const isListItem = LIST_MARKER.test(line.line);

  if (isUser) {
    return (
      <div className="flex flex-col py-0.5 rounded px-1 -mx-1 items-end hover:bg-slate-800/30">
        <div className="flex items-start gap-2 max-w-[90%] justify-end">
          {/* YOUR words. This is the anchor the eye returns to when scanning a
              pane, so it gets everything: right-aligned (breaks the left rag of
              agent output), a solid accent fill rather than a 25% wash, a left
              border as a hard edge, and semibold. You should be able to find
              your last message in a wall of output without reading anything. */}
          <span
            data-line-source="user"
            className="min-w-0 whitespace-pre-wrap break-words leading-relaxed rounded-md rounded-l-sm border-l-2 border-sky-400 px-2.5 py-1 font-terminal font-semibold bg-sky-500/20 text-sky-50 shadow-sm"
          >
            {line.line}
          </span>
        </div>
        {showThinking && line.thinking && (
          <div className="mr-0 mt-0.5">
            <ThinkingBlock label="Thinking…" content={line.thinking} live={false} compact={compact} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col py-0.5 px-1 -mx-1 ${
        isInfo ? 'opacity-70' : ''
      } hover:bg-slate-800/30`}
    >
      {/* Contrast is deliberate and tiered — this pane is scanned at a glance,
          so the three classes must be separable by weight and brightness alone,
          without reading a single word:
            agent output → brightest + medium weight (the signal)
            info/chrome  → dim, italic, small (present but never competing)
          `slate-300` for agent output was mid-grey on a near-black pane: legible
          if you stopped to read, invisible if you were skimming. */}
      <span
        className={`min-w-0 whitespace-pre-wrap leading-relaxed font-terminal overflow-x-auto ${
          isInfo
            ? 'text-slate-500 italic text-[12px]'
            : isListItem
              ? 'text-slate-100 font-medium pl-1'
              : 'text-slate-100 font-medium'
        }`}
      >
        {line.line}
      </span>
      {showThinking && line.thinking && (
        <div className="ml-2 mt-0.5">
          <ThinkingBlock label="Thinking…" content={line.thinking} live={false} compact={compact} />
        </div>
      )}
    </div>
  );
}

