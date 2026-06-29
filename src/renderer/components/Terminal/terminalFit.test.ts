import { describe, it, expect } from 'vitest';
import { calculateFit } from './terminalFit';

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
