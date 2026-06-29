import { describe, it, expect, vi } from 'vitest';
import { calculateFit, fitTerminal } from './terminalFit';
import type { Terminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';

describe('calculateFit', () => {
  it('does not expand cols when the only width gap is the vertical scrollbar', () => {
    // Scenario: host 1000px, padding 16px (8 each side), screen 960px,
    // viewport 984px => scrollbar width 24px. Cell width 12px.
    // FitAddon would propose cols = floor((1000 - 16) / 12) = 82.
    // With scrollbar accounted for: floor((1000 - 16 - 24) / 12) = 80.
    // Starting cols are 80, so the guard should keep them at 80.
    const result = calculateFit(
      { cols: 82, rows: 24 },
      80,
      24,
      {
        hostClientWidth: 1000,
        hostClientHeight: 600,
        hostRectWidth: 1000,
        screenOffsetWidth: 960,
        screenOffsetHeight: 580,
        viewportOffsetWidth: 984,
        paddingHor: 16,
        cellWidth: 12,
      },
    );

    expect(result.scrollBarWidth).toBe(24);
    expect(result.widthGuardFired).toBe(false);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('reduces cols when the container genuinely shrinks', () => {
    const result = calculateFit(
      { cols: 60, rows: 24 },
      80,
      24,
      {
        hostClientWidth: 800,
        hostClientHeight: 600,
        hostRectWidth: 800,
        screenOffsetWidth: 784,
        screenOffsetHeight: 580,
        viewportOffsetWidth: 800,
        paddingHor: 16,
        cellWidth: 12,
      },
    );

    expect(result.cols).toBe(60);
    expect(result.rows).toBe(24);
    expect(result.widthGuardFired).toBe(true);
  });

  it('handles missing scrollbar gracefully', () => {
    const result = calculateFit(
      { cols: 80, rows: 24 },
      80,
      24,
      {
        hostClientWidth: 1000,
        hostClientHeight: 600,
        hostRectWidth: 1000,
        screenOffsetWidth: 1000,
        screenOffsetHeight: 580,
        viewportOffsetWidth: 1000,
        paddingHor: 0,
        cellWidth: 12,
      },
    );

    expect(result.scrollBarWidth).toBe(0);
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);
  });

  it('fires width guard when scrollbar would push cols over', () => {
    const result = calculateFit(
      { cols: 82, rows: 24 },
      82,
      24,
      {
        hostClientWidth: 1000,
        hostClientHeight: 600,
        hostRectWidth: 1000,
        screenOffsetWidth: 960,
        screenOffsetHeight: 580,
        viewportOffsetWidth: 984,
        paddingHor: 16,
        cellWidth: 12,
      },
    );

    expect(result.widthGuardFired).toBe(true);
    expect(result.cols).toBe(80);
  });
});

describe('fitTerminal', () => {
  function makeHost(measurements: {
    hostClientWidth: number;
    hostClientHeight: number;
    hostRectWidth: number;
    viewportOffsetWidth: number;
    screenOffsetWidth: number;
    screenOffsetHeight: number;
  }) {
    const viewport = {
      classList: { contains: () => true },
      offsetWidth: measurements.viewportOffsetWidth,
      offsetHeight: measurements.hostClientHeight,
    } as unknown as HTMLElement;

    const screen = {
      classList: { contains: () => true },
      offsetWidth: measurements.screenOffsetWidth,
      offsetHeight: measurements.screenOffsetHeight,
    } as unknown as HTMLElement;

    const host = {
      clientWidth: measurements.hostClientWidth,
      clientHeight: measurements.hostClientHeight,
      getBoundingClientRect: () => ({
        width: measurements.hostRectWidth,
        height: measurements.hostClientHeight,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: measurements.hostClientHeight,
        right: measurements.hostRectWidth,
        toJSON: () => ({}),
      }),
      querySelector: (selector: string) => {
        if (selector === '.xterm-viewport') return viewport;
        if (selector === '.xterm-screen') return screen;
        return null;
      },
    } as unknown as HTMLElement;

    return { host, viewport, screen };
  }

  function makeTerm(cols: number, rows: number) {
    let currentCols = cols;
    let currentRows = rows;
    return {
      cols: currentCols,
      rows: currentRows,
      resize: (c: number, r: number) => {
        currentCols = c;
        currentRows = r;
      },
      get currentCols() {
        return currentCols;
      },
      get currentRows() {
        return currentRows;
      },
      _core: {
        _renderService: {
          dimensions: {
            css: {
              cell: {
                width: 12,
              },
            },
          },
        },
      },
    } as unknown as Terminal & { currentCols: number; currentRows: number };
  }

  function makeFitAddon(proposed: { cols: number; rows: number }) {
    return {
      proposeDimensions: () => ({ ...proposed }),
    } as unknown as FitAddon;
  }

  it('uses full available width in a large pane with scrollbar (regression #10365)', () => {
    // Wide terminal: host 1600px, padding 16px, viewport 1584px (scrollbar 24px),
    // screen 1560px. Cell width 12px.
    // Correct cols = floor((1600 - 16 - 24) / 12) = 130.
    // Buggy double-subtract would give floor((1600 - 40 - 24) / 12) = 128.
    const { host } = makeHost({
      hostClientWidth: 1600,
      hostClientHeight: 900,
      hostRectWidth: 1600,
      viewportOffsetWidth: 1584,
      screenOffsetWidth: 1560,
      screenOffsetHeight: 880,
    });
    const term = makeTerm(80, 24);
    const fitAddon = makeFitAddon({ cols: 132, rows: 56 });

    fitTerminal(term, fitAddon, host, 'test-large-pane');

    expect(term.currentCols).toBe(130);
  });

  it('does not double-count scrollbar in a narrow left pane (window-too-small scenario)', () => {
    // Narrow left pane: host 260px, padding 8px (4 each side), viewport 252px,
    // scrollbar 12px, screen 240px. Cell width 12px.
    // Correct cols = floor((260 - 8 - 12) / 12) = 20.
    // Buggy double-subtract would give floor((260 - 20 - 12) / 12) = 19.
    const { host } = makeHost({
      hostClientWidth: 260,
      hostClientHeight: 300,
      hostRectWidth: 260,
      viewportOffsetWidth: 252,
      screenOffsetWidth: 240,
      screenOffsetHeight: 280,
    });
    const term = makeTerm(20, 12);
    const fitAddon = makeFitAddon({ cols: 21, rows: 18 });

    fitTerminal(term, fitAddon, host, 'test-narrow-pane');

    expect(term.currentCols).toBe(20);
  });

  it('still guards against scrollbar over-allocation (original WO 92267 bug)', () => {
    // FitAddon proposes too many cols because it ignores scrollbar.
    // host 1000px, padding 16px, viewport 984px, scrollbar 24px, screen 960px.
    // Proposed 82 should be clamped to 80.
    const { host } = makeHost({
      hostClientWidth: 1000,
      hostClientHeight: 600,
      hostRectWidth: 1000,
      viewportOffsetWidth: 984,
      screenOffsetWidth: 960,
      screenOffsetHeight: 580,
    });
    const term = makeTerm(82, 24);
    const fitAddon = makeFitAddon({ cols: 82, rows: 48 });

    const result = fitTerminal(term, fitAddon, host, 'test-scrollbar-guard');

    expect(result.widthGuardFired).toBe(true);
    expect(term.currentCols).toBe(80);
  });

  it('uses full width in a 6-pane grid cell (~600px) with scrollbar', () => {
    // Approximates the 3x2 grid in BAPert's second screenshot (1917x1012).
    // Pane ~600px wide after gaps/borders. With padding 14px and scrollbar 16px,
    // screen is 570px. Cell width 12px.
    // Correct cols = floor((600 - 14 - 16) / 12) = 47.
    // Buggy double-subtract would give floor((600 - 30 - 16) / 12) = 46.
    const { host } = makeHost({
      hostClientWidth: 600,
      hostClientHeight: 460,
      hostRectWidth: 600,
      viewportOffsetWidth: 586,
      screenOffsetWidth: 570,
      screenOffsetHeight: 440,
    });
    const term = makeTerm(60, 20);
    const fitAddon = makeFitAddon({ cols: 49, rows: 42 });

    fitTerminal(term, fitAddon, host, 'test-6-pane-grid');

    expect(term.currentCols).toBe(47);
  });
});
