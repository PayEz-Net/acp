import type { Terminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';

/**
 * Minimum usable terminal dimensions. These values are the floor for any
 * resize operation. Going below them causes xterm to render its red
 * "window too small..." banner and makes scrollback unreachable.
 *
 * Tuned for the compact sidebar panes used in focus-left layout: even a very
 * narrow pane must stay a functional terminal with reachable history.
 */
export const MIN_COLS = 10;
export const MIN_ROWS = 4;

interface FitMeasurements {
  hostClientWidth: number;
  hostClientHeight: number;
  hostRectWidth: number;
  screenOffsetWidth: number;
  screenOffsetHeight: number;
  viewportOffsetWidth: number;
  paddingHor: number;
  cellWidth: number;
  cellHeight: number;
}

interface Diagnostics {
  reason: string;
  hostClientWidth?: number;
  hostRectWidth?: number;
  screenOffsetWidth?: number;
  scrollBarWidth?: number;
  paddingHor?: number;
  termCols?: number;
  targetCols?: number;
  widthGuardFired?: boolean;
  rowGuardFired?: boolean;
}

function logDiagnostics(phase: string, data: Diagnostics) {
  // Only log in non-test environments; production builds keep console.info
  // so the _diag installer can capture these.
  if (typeof console !== 'undefined' && console.info) {
    console.info(`[terminalFit:diagnostics] ${phase}`, data);
  }
}

/**
 * Pure calculation: given container/scrollbar/cell measurements and FitAddon's
 * proposal, return the corrected columns and rows.
 *
 * The key fix for WO 92267: when a vertical scrollbar is present, FitAddon's
 * raw proposal over-allocates columns because it ignores the scrollbar gutter.
 * We recompute columns using the same effective width budget as FitAddon but
 * with the scrollbar width subtracted: host - padding - scrollbar. If the
 * terminal's current cols already equal the corrected target, the width guard
 * does not fire (diagnostic shows widthGuardFired: false).
 *
 * Additionally, the result is clamped to MIN_COLS/MIN_ROWS so that compact
 * sidebar panes never collapse into xterm's "window too small" state.
 */
export function calculateFit(
  proposed: { cols: number; rows: number } | undefined,
  currentCols: number,
  currentRows: number,
  measurements: FitMeasurements,
): { cols: number; rows: number; scrollBarWidth: number; widthGuardFired: boolean; rowGuardFired: boolean } {
  const scrollBarWidth = Math.max(0, measurements.viewportOffsetWidth - measurements.screenOffsetWidth);

  // Start from FitAddon's proposal, then correct for scrollbar.
  let targetCols = proposed?.cols ?? currentCols;
  let targetRows = proposed?.rows ?? currentRows;

  if (scrollBarWidth > 0 && measurements.cellWidth > 0) {
    const availableWidth = Math.max(0, measurements.hostClientWidth - measurements.paddingHor - scrollBarWidth);
    const correctedCols = Math.floor(availableWidth / measurements.cellWidth);
    if (correctedCols < targetCols) {
      targetCols = correctedCols;
    }
  }

  // Width guard fires only if the terminal's current columns exceed the
  // corrected target. If the terminal already fits the corrected budget, the
  // guard stays quiet (the fix prevented over-expansion, it did not shrink).
  const widthGuardFired = currentCols > targetCols;

  // Bottom-row guard (#164): when the rendered screen is taller than its host,
  // derive the maximum rows from the host height and cell height instead of
  // blindly decrementing. The result is clamped to MIN_ROWS so the terminal
  // stays usable even in a very short pane.
  let rowGuardFired = false;
  if (measurements.screenOffsetHeight > measurements.hostClientHeight && measurements.cellHeight > 0) {
    const maxRowsFromHeight = Math.floor(measurements.hostClientHeight / measurements.cellHeight);
    const clampedMaxRows = Math.max(MIN_ROWS, maxRowsFromHeight);
    if (targetRows > clampedMaxRows) {
      targetRows = clampedMaxRows;
      rowGuardFired = true;
    }
  }

  // Enforce absolute minimum usable dimensions.
  targetCols = Math.max(MIN_COLS, targetCols);
  targetRows = Math.max(MIN_ROWS, targetRows);

  return { cols: targetCols, rows: targetRows, scrollBarWidth, widthGuardFired, rowGuardFired };
}

function getCellWidth(term: Terminal): number {
  const dims = term as unknown as { _core?: { _renderService?: { dimensions: { css: { cell: { width: number } } } } } };
  return dims._core?._renderService?.dimensions?.css?.cell?.width ?? 0;
}

function getCellHeight(term: Terminal): number {
  const dims = term as unknown as { _core?: { _renderService?: { dimensions: { css: { cell: { height: number } } } } } };
  return dims._core?._renderService?.dimensions?.css?.cell?.height ?? 0;
}

/**
 * Fit the terminal to its container while accounting for the vertical scrollbar.
 */
export function fitTerminal(
  term: Terminal,
  fitAddon: FitAddon,
  host: HTMLElement,
  reason: string,
): { cols: number; rows: number; scrollBarWidth: number; widthGuardFired: boolean } {
  // Flush layout so subsequent DOM measurements are current.
  if (typeof host.getBoundingClientRect === 'function') host.getBoundingClientRect();

  const viewport = host.querySelector('.xterm-viewport') as HTMLElement | null;
  const screen = host.querySelector('.xterm-screen') as HTMLElement | null;

  const rect = host.getBoundingClientRect();
  const hostClientWidth = host.clientWidth;
  const hostClientHeight = host.clientHeight;
  const screenOffsetWidth = screen?.offsetWidth ?? hostClientWidth;
  const screenOffsetHeight = screen?.offsetHeight ?? hostClientHeight;
  const viewportOffsetWidth = viewport?.offsetWidth ?? hostClientWidth;

  // Horizontal padding inside the host. The scrollbar is part of the viewport,
  // so padding must be measured against viewport width, not screen width,
  // otherwise the scrollbar width is subtracted twice in calculateFit.
  const paddingHor = Math.max(0, hostClientWidth - viewportOffsetWidth);

  const proposed = fitAddon.proposeDimensions();
  const cellWidth = getCellWidth(term);
  const cellHeight = getCellHeight(term);

  const result = calculateFit(proposed, term.cols, term.rows, {
    hostClientWidth,
    hostClientHeight,
    hostRectWidth: rect.width,
    screenOffsetWidth,
    screenOffsetHeight,
    viewportOffsetWidth,
    paddingHor,
    cellWidth,
    cellHeight,
  });

  if (result.cols !== term.cols || result.rows !== term.rows) {
    term.resize(result.cols, result.rows);
  }

  logDiagnostics('after-fit', {
    reason,
    hostClientWidth,
    hostRectWidth: rect.width,
    screenOffsetWidth,
    scrollBarWidth: result.scrollBarWidth,
    paddingHor,
    termCols: term.cols,
    targetCols: result.cols,
    widthGuardFired: result.widthGuardFired,
    rowGuardFired: result.rowGuardFired,
  });

  return {
    cols: term.cols,
    rows: term.rows,
    scrollBarWidth: result.scrollBarWidth,
    widthGuardFired: result.widthGuardFired,
  };
}
