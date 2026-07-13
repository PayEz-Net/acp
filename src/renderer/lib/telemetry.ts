/**
 * Lightweight client-side telemetry for feature usage and failure signals.
 *
 * Events are logged in development builds and are no-ops in production until
 * a backend sink is wired. No PII or image bytes are ever collected.
 */

export type TelemetryEvent =
  | { event: 'image_paste_sent'; imageCount: number; totalSizeBytes: number }
  | { event: 'image_paste_failed'; errorCode: string };

const queue: TelemetryEvent[] = [];

export function trackEvent(event: TelemetryEvent): void {
  queue.push(event);
  if (process.env.NODE_ENV === 'development') {
    // eslint-disable-next-line no-console
    console.log('[telemetry]', event);
  }
}

export function getTelemetryQueue(): readonly TelemetryEvent[] {
  return queue;
}

export function clearTelemetryQueue(): void {
  queue.length = 0;
}
