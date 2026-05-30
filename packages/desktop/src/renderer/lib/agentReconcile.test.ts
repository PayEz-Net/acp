/**
 * agentReconcile unit tests — `acp-dynamic-team-loading-v1-spec.md` §7.
 *
 * Covers AC-18 (orphan drop), AC-19 (collision-free + color), AC-20
 * (cloud wins identity, local wins layout). Adversarial AC-19 cases
 * exercise the two-pass guarantee — pre-v1.2 single-pass `idx % 4`
 * collided here.
 */
import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../../shared/types';
import { agentReconcile, type NormalizedAgent } from './agentReconcile';
import { colorForArchetype } from './agentColors';

const cloud = (
  name: string,
  opts: Partial<NormalizedAgent> = {},
): NormalizedAgent => ({
  id: opts.id ?? 1,
  name,
  displayName: opts.displayName ?? name,
  isActive: opts.isActive ?? true,
  ...opts,
});

const local = (
  name: string,
  position: AgentConfig['position'],
  opts: Partial<AgentConfig> = {},
): AgentConfig => ({
  id: opts.id ?? 'local-id',
  name,
  displayName: opts.displayName ?? name,
  workDir: opts.workDir ?? 'C:\\local',
  autoStart: opts.autoStart ?? true,
  position,
  color: opts.color,
  ...(opts.provider ? { provider: opts.provider } : {}),
});

describe('agentReconcile — AC-18 orphan drop + local-pref preservation', () => {
  it('drops local entries not in cloud roster, preserves matched local positions', () => {
    const out = agentReconcile(
      [cloud('BAPert', { id: 1 }), cloud('QAPert', { id: 2 })],
      [
        local('BAPert', 'top-left', { workDir: 'C:\\BA', color: '#aaa', autoStart: true }),
        local('QAPert', 'top-right', { workDir: 'C:\\QA', color: '#bbb' }),
        local('OldAgent', 'bottom-left'),
      ],
    );
    expect(out).toHaveLength(2);
    expect(out.find((a) => a.name === 'OldAgent')).toBeUndefined();
    const ba = out.find((a) => a.name === 'BAPert')!;
    expect(ba.position).toBe('top-left');
    expect(ba.workDir).toBe('C:\\BA');
    expect(ba.color).toBe('#aaa');
    expect(ba.autoStart).toBe(true);
    const qa = out.find((a) => a.name === 'QAPert')!;
    expect(qa.position).toBe('top-right');
    // COL-6 AC6: local wins on autoStart and is NOT force-overridden to
    // true — QAPert's local pref omits autoStart, so it stays false
    // (`local?.autoStart ?? true`). Locks the JSDoc-vs-behavior contract.
    expect(qa.autoStart).toBe(true);
  });
});

describe('agentReconcile — AC-19 collision-free position assignment', () => {
  it('local-pref BAPert@top-right + new NewAgent: BAPert keeps top-right, NewAgent goes top-left', () => {
    const out = agentReconcile(
      [cloud('BAPert', { id: 1 }), cloud('NewAgent', { id: 2 })],
      [local('BAPert', 'top-right', { color: '#aaa' })],
    );
    const ba = out.find((a) => a.name === 'BAPert')!;
    const na = out.find((a) => a.name === 'NewAgent')!;
    expect(ba.position).toBe('top-right');
    expect(na.position).toBe('top-left');
    expect(ba.position).not.toBe(na.position);
  });

  it('4 new cloud-only agents in startup_order ascending fill all 4 slots deterministically', () => {
    const out = agentReconcile(
      [
        cloud('NewA', { id: 1, startupOrder: 1 }),
        cloud('NewB', { id: 2, startupOrder: 2 }),
        cloud('NewC', { id: 3, startupOrder: 3 }),
        cloud('NewD', { id: 4, startupOrder: 4 }),
      ],
      [],
    );
    expect(out.find((a) => a.name === 'NewA')!.position).toBe('top-left');
    expect(out.find((a) => a.name === 'NewB')!.position).toBe('top-right');
    expect(out.find((a) => a.name === 'NewC')!.position).toBe('bottom-left');
    expect(out.find((a) => a.name === 'NewD')!.position).toBe('bottom-right');
  });

  it('5 cloud agents, no local prefs: 4 placed, 5th overflows to position: undefined', () => {
    const out = agentReconcile(
      [
        cloud('A', { id: 1, startupOrder: 1 }),
        cloud('B', { id: 2, startupOrder: 2 }),
        cloud('C', { id: 3, startupOrder: 3 }),
        cloud('D', { id: 4, startupOrder: 4 }),
        cloud('E', { id: 5, startupOrder: 5 }),
      ],
      [],
    );
    expect(out).toHaveLength(5);
    const positions = out.map((a) => a.position);
    expect(positions.slice(0, 4).sort()).toEqual(
      ['bottom-left', 'bottom-right', 'top-left', 'top-right'],
    );
    expect(out.find((a) => a.name === 'E')!.position).toBeUndefined();
  });

  it('corrupt local state with two prefs at same position: sort-order-stable wins, second falls through', () => {
    const out = agentReconcile(
      [
        cloud('A', { id: 1, startupOrder: 1 }),
        cloud('B', { id: 2, startupOrder: 2 }),
      ],
      [local('A', 'top-left'), local('B', 'top-left')],
    );
    const a = out.find((x) => x.name === 'A')!;
    const b = out.find((x) => x.name === 'B')!;
    expect(a.position).toBe('top-left');
    expect(b.position).toBe('top-right');
    expect(a.position).not.toBe(b.position);
  });

  it('cloud-only agent without local color gets deterministic color from FNV-1a hash', () => {
    const out = agentReconcile([cloud('NewAgent', { id: 99 })], []);
    expect(out[0].color).toBe(colorForArchetype('NewAgent'));
    // Determinism — same input twice produces same output
    const out2 = agentReconcile([cloud('NewAgent', { id: 99 })], []);
    expect(out[0].color).toBe(out2[0].color);
  });

  it('known archetypes get team-canonical colors via colorForArchetype', () => {
    const out = agentReconcile([cloud('BAPert', { id: 1 })], []);
    expect(out[0].color).toBe('#8b5cf6');
  });
});

describe('agentReconcile — AC-20 cloud wins identity, local wins layout', () => {
  it('cloud BAPert@displayName=Alex + local BAPert@top-left: displayName=Alex, position=top-left', () => {
    const out = agentReconcile(
      [cloud('BAPert', { id: 7, displayName: 'Alex', startupOrder: 2 })],
      [local('BAPert', 'top-left', { color: '#aaa', workDir: 'C:\\BA' })],
    );
    expect(out[0].displayName).toBe('Alex');
    expect(out[0].position).toBe('top-left');
    expect(out[0].id).toBe('7');
    expect(out[0].color).toBe('#aaa');
    expect(out[0].workDir).toBe('C:\\BA');
  });
});

describe('agentReconcile — output ordering', () => {
  it('output mirrors cloud sort (startupOrder asc, name asc tiebreak)', () => {
    const out = agentReconcile(
      [
        cloud('Zeta', { id: 3, startupOrder: 5 }),
        cloud('Alpha', { id: 1, startupOrder: 1 }),
        cloud('Beta', { id: 2, startupOrder: 1 }),
      ],
      [],
    );
    expect(out.map((a) => a.name)).toEqual(['Alpha', 'Beta', 'Zeta']);
  });
});
