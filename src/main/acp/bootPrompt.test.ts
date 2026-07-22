import { describe, it, expect } from 'vitest';
import { buildAgentBootPrompt, buildAgentResumeNudge } from './bootPrompt';

// WO 11444: agents kept ignoring [ACP Mail] push notices because the prompts
// never said the tag is an instruction. Both onboarding paths must name it.
describe('boot prompt mail-push instruction (WO 11444)', () => {
  it('boot prompt tells the agent an [ACP Mail] user-turn is an instruction to act', () => {
    const prompt = buildAgentBootPrompt('NextPert');
    expect(prompt).toContain('[ACP Mail]');
    expect(prompt).toMatch(/\[ACP Mail\][^\n]*system notification/);
    expect(prompt).toMatch(/check your inbox immediately/);
  });

  it('resume nudge carries the same instruction and overrides the wait rule', () => {
    const nudge = buildAgentResumeNudge('NextPert', { unreadCount: 2 });
    expect(nudge).toContain('[ACP Mail]');
    expect(nudge).toMatch(/check your inbox immediately/);
    expect(nudge).toMatch(/overrides the wait-for-the-next-user-message rule/);
  });
});
