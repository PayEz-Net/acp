import { describe, expect, it } from 'vitest';
import { extractDriftAlert, driftAlertKey, formatDriftAlertNotice } from './mailDriftAlert';

describe('mailDriftAlert (209637)', () => {
  it('extracts a stamped alert from an inbox response', () => {
    const res = {
      success: true,
      data: {
        messages: [],
        platform_alert: { type: 'CURRENT_PROJECT_DRIFT', from: 31, to: 18, message: 'm' },
      },
    };
    const alert = extractDriftAlert(res);
    expect(alert).not.toBeNull();
    expect(alert!.to).toBe(18);
  });

  it('returns null when there is no alert or the type is wrong', () => {
    expect(extractDriftAlert(null)).toBeNull();
    expect(extractDriftAlert({ data: { messages: [] } })).toBeNull();
    expect(extractDriftAlert({ data: { platform_alert: { type: 'SOMETHING_ELSE' } } })).toBeNull();
  });

  it('dedupe key is the transition, not the clock', () => {
    expect(driftAlertKey({ type: 'CURRENT_PROJECT_DRIFT', from: 31, to: 18 })).toBe('31->18');
    expect(driftAlertKey({ type: 'CURRENT_PROJECT_DRIFT', from: null, to: 18 })).toBe('null->18');
  });

  it('the notice names both projects and points at the setting', () => {
    const text = formatDriftAlertNotice({ type: 'CURRENT_PROJECT_DRIFT', from: 31, to: 18 });
    expect(text).toContain('31');
    expect(text).toContain('18');
    expect(text).toContain('current-project');
  });
});
