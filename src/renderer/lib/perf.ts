/**
 * Lightweight performance markers for renderer diagnostics.
 *
 * These are temporary telemetry helpers used to validate the terminal
 * performance work order. Markers are only recorded in development builds
 * and are no-ops in production.
 */

export interface PerfMarker {
  name: string;
  start: number;
  end: number;
  duration: number;
  metadata?: Record<string, unknown>;
}

const markers: PerfMarker[] = [];

export function perfNow(): number {
  return performance.now();
}

export function perfMeasure(name: string, start: number, metadata?: Record<string, unknown>): PerfMarker {
  const end = perfNow();
  const duration = end - start;
  const marker = { name, start, end, duration, metadata };
  if (process.env.NODE_ENV === 'development') {
    markers.push(marker);
    if (markers.length > 200) {
      markers.splice(0, markers.length - 200);
    }
    if (duration > 5) {
      console.log(`[perf] ${name}: ${duration.toFixed(2)}ms`, metadata ?? '');
    }
  }
  return marker;
}

export function perfMark(name: string, _metadata?: Record<string, unknown>): number {
  if (process.env.NODE_ENV === 'development') {
    performance.mark?.(`${name}-start`);
  }
  return perfNow();
}

export function getPerfMarkers(): readonly PerfMarker[] {
  return markers;
}

export function clearPerfMarkers(): void {
  markers.length = 0;
}
