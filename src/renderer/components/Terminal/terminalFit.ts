import type { Terminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';

interface FitMeasurements {
  hostClientWidth: number;
  hostClientHeight: number;
  hostRectWidth: number;
  screenOffsetWidth: number;
  screenOffsetHeight: number;
  viewportOffsetWidth: number;
  paddingHor: number;
  cellWidth: number;
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

  // Bottom-row guard (#164): drop rows until the rendered terminal fits.
  let rowGuardFired = false;
  if (measurements.screenOffsetHeight > measurements.hostClientHeight) {
    let guard = 0;
    while (measurements.screenOffsetHeight > measurements.hostClientHeight && targetRows > 1 && guard < 12) {
      targetRows--;
      rowGuardFired = true;
      guard++;
    }
  }

  return { cols: targetCols, rows: targetRows, scrollBarWidth, widthGuardFired, rowGuardFired };
}

function getCellWidth(term: Terminal): number {
  const dims = term as unknown as { _core?: { _renderService?: { dimensions: { css: { cell: { width: number } } } } } };
  return dims._core?._renderService?.dimensions?.css?.cell?.width ?? 0;
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

  const result = calculateFit(proposed, term.cols, term.rows, {
    hostClientWidth,
    hostClientHeight,
    hostRectWidth: rect.width,
    screenOffsetWidth,
    screenOffsetHeight,
    viewportOffsetWidth,
    paddingHor,
    cellWidth,
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
