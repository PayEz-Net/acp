import { describe, it, expect } from 'vitest';
import { buildAgentBootPrompt, buildAgentResumeNudge } from './bootPrompt';

// WO 11444: agents kept ignoring [ACP Mail] push notices because the prompts
// never said the tag is an instruction. Both onboarding paths must name it.
describe('boot prompt mail-push instruction (WO 11444)', () => {
  it('boot prompt tells the agent an [ACP Mail] user-turn is an instruction to act', () => {
    const prompt = buildAgentBootPrompt('NextPert');
    expect(prompt).toContain('[ACP Mail]');
    expect(prompt).toMatch(/\[ACP Mail\][^\n]*system notification/);
    expect(prompt).toMatch(/act on actionable messages immediately/);
  });

  it('resume nudge carries the same instruction and overrides the wait rule', () => {
    const nudge = buildAgentResumeNudge('NextPert', { unreadCount: 2 });
    expect(nudge).toContain('[ACP Mail]');
    expect(nudge).toMatch(/act on actionable messages immediately/);
    expect(nudge).toMatch(/overrides the wait-for-the-next-user-message rule/);
  });
});

// SESSION_INACTIVE antidote: an upstream "Session is not active" error left in
// the agent's history made the team lead conclude he was deactivated and go
// permanently silent. Both onboarding paths must neutralize that reading.
describe('SESSION_INACTIVE antidote', () => {
  it('boot prompt says SESSION_INACTIVE is transient and never about the agent', () => {
    const prompt = buildAgentBootPrompt('NextPert');
    expect(prompt).toContain('SESSION_INACTIVE');
    expect(prompt).toMatch(/NEVER about you/);
    expect(prompt).toMatch(/never go silent/i);
  });

  it('resume nudge neutralizes a stale SESSION_INACTIVE in the resumed history', () => {
    const nudge = buildAgentResumeNudge('NextPert');
    expect(nudge).toContain('SESSION_INACTIVE');
    expect(nudge).toMatch(/NEVER about you/);
    expect(nudge).toMatch(/never go silent/i);
    expect(nudge).toMatch(/session is live right now/i);
  });
});

// Human-interrupt rule (NGTMI: "the team lead ignores me"): a busy episode is
// never a reason to leave the human on read — answer first, text before tools.
describe('human-interrupt rule', () => {
  it('boot prompt makes the human outrank mail and any in-flight task', () => {
    const prompt = buildAgentBootPrompt('NextPert');
    expect(prompt).toMatch(/human outranks mail and any in-flight work/);
    expect(prompt).toMatch(/before your next tool call/);
  });
});
