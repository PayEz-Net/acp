/**
 * Spawn Orchestrator — Wave C Commit B.
 *
 * Bridges the lifecycle-poller (Commit A) to pty.spawnAgent. When the
 * cloud lifecycle for the current project flips IDLE/INCOMPLETE →
 * RUNNING, fetches the project team + each agent's Wave D boot-prompt
 * and spawns. When RUNNING → PAUSED/IDLE/INCOMPLETE, tears down the
 * spawned agents.
 *
 * Per BAPert msg 1146:
 *   - For each team member: GET /v1/projects/:id/team → team list
 *   - For each member: GET /v1/projects/:id/boot-prompt/:agent_id
 *   - spawnAgent(name, workDir, { bootPrompt })
 *   - Track spawned PTY ids per project for teardown coordination
 *
 * Wave C/2 (runtime override per-agent) is filed for v1.x — for now
 * the global `agentProvider` from settings drives the spawn runtime
 * uniformly per BAPert msg 1148 Q2 answer.
 */

import * as fs from 'fs';
import { spawnAgent, killTerminal, getAgentSessionByAgent, WorkDirError, RuntimeNotSetError, emitSpawnFailed, emitNoTeamEngaged } from './pty';
import { endAgentSession } from './agentSessionLifecycle';
import { getLocalSecret } from './api-server';
import { colonizeWorkspace } from './colonize';
import { getSettings } from './store';
import { buildAgentBootPrompt } from './acp/bootPrompt';
import { acpApiGetAgentProfile, acpApiGetUnreadMailCount, registerPtyTerminal } from './acp-api-client';
import { onLifecycleHubEvent, type LifecycleState, type ProjectLifecycleChangedEvent } from './lifecycle-hub';
import { narrowClaudeEffort } from '../shared/types';

const ACP_API_BASE = process.env.ACP_API_URL || 'http://127.0.0.1:3001';

interface ProjectTeamMember {
  agent_id: number;
  agent_name: string;
  agent_display_name: string | null;
  canonical_role: string | null;
  role: string | null;
  runtime_override: string | null;
  work_dir_override: string | null;
  effort_override: string | null;
  // Bare kimi model id (WO-KIMI-MODEL-OVERRIDE). Passed through RAW to the
  // spawn boundary — unknown ids must fail loud there, never be narrowed
  // into a silent inherit here.
  model_override: string | null;
  position_hint: string | null;
  is_lead: boolean;
}

interface ProjectDto {
  id: number;
  name: string;
  repo_path: string | null;
  runtime_choice: string | null;
}

interface SpawnedAgentRecord {
  projectId: number;
  agentId: number;
  agentName: string;
  terminalId: string;
  spawnedAt: string;
}

// Map<projectId, SpawnedAgentRecord[]> — track what's running per
// project so teardown can target precisely. Survives lifecycle state
// transitions; cleared on teardown.
const spawnedByProject = new Map<number, SpawnedAgentRecord[]>();

// Idempotency guard: prevents double-seed on connect/reconnect.
const seededProjects = new Set<number>();

// Only orchestrate the current/active project. Set from the first
// RUNNING transition we see; ignores other projects' events.
// TODO(QAPert-L4): this singleton blocks true multi-project concurrent
// spawn. Redesign needed: maintain a Set<projectId> of RUNNING projects
// and orchestrate each independently (or queue + debounce).
let currentProjectId: number | null = null;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    // Local sidecar (acp-api) requires the local-secret Bearer on
    // /v1/projects/* — same auth the renderer's projectRequest and
    // lifecycle-server use. Without it: 401 → "project not found" →
    // spawn aborted (the dev sidecar didn't enforce it; packaged does).
    const secret = getLocalSecret();
    const res = await fetch(url, {
      method: 'GET',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    if (!res.ok) {
      // Instrument the exact failure — the swallowed body is why this was
      // opaque. localAuth → {error:{code:'UNAUTHORIZED',message:'Invalid
      // bearer token'}} = secret mismatch; route → 'NOT_AUTHENTICATED' =
      // IDP session/cloud auth. secretLen tells us getLocalSecret() fired.
      const body = await res.text().catch(() => '(unreadable)');
      console.warn(`[SpawnOrch] ${url} → HTTP ${res.status} | secretLen=${secret ? secret.length : 'NONE'} | body=${body.slice(0, 300)}`);
      return null;
    }
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text) as T; } catch { return null; }
  } catch (err) {
    console.warn(`[SpawnOrch] ${url} fetch failed:`, err);
    return null;
  }
}

async function fetchProject(projectId: number): Promise<ProjectDto | null> {
  const body = await fetchJson<Record<string, unknown>>(
    `${ACP_API_BASE}/v1/projects/${projectId}`,
  );
  if (!body) return null;
  // acp-api /v1/projects/:id returns success(extractAndMapDetail(...)) =
  // { data: { project: {…repo_path…}, members } }. The path lives at
  // data.project.repo_path — NOT data.repo_path. Unwrap .project (the
  // bug: this read `data` as the project, so repo_path was undefined →
  // "NO workspace root → refusing to spawn"). Tolerate a flat shape too.
  const data = (body.data ?? body) as Record<string, unknown>;
  const proj = (data.project ?? data) as ProjectDto;
  return proj && typeof proj.id === 'number' ? proj : null;
}

async function fetchTeam(projectId: number): Promise<ProjectTeamMember[]> {
  const body = await fetchJson<{ success?: boolean; data?: { team?: ProjectTeamMember[] }; team?: ProjectTeamMember[] }>(
    `${ACP_API_BASE}/v1/projects/${projectId}/team`,
  );
  if (!body) return [];
  const inner = (body as { data?: { team?: ProjectTeamMember[] } }).data ?? body;
  const team = (inner as { team?: ProjectTeamMember[] })?.team;
  return Array.isArray(team) ? team : [];
}

async function buildLocalBootPrompt(agentName: string): Promise<string> {
  // Pre-fetch the agent's canonical identity and unread mail count so the
  // onboarding prompt can include them directly. This avoids making the agent
  // fire a tool call during its initial turn, which was the root cause of the
  // Kimi ACP state-machine race that left Nextpert-Scout (and any other
  // dynamically-named agent) unable to start.
  const [profile, unreadCount] = await Promise.all([
    acpApiGetAgentProfile(agentName).catch((err) => {
      console.warn(`[SpawnOrch] profile fetch failed for ${agentName}:`, err);
      return null;
    }),
    acpApiGetUnreadMailCount(agentName).catch((err) => {
      console.warn(`[SpawnOrch] unread mail fetch failed for ${agentName}:`, err);
      return null;
    }),
  ]);
  console.log(`[SpawnOrch] boot prompt data for ${agentName}: profile=${profile ? 'present' : 'missing'} unread=${unreadCount ?? 'missing'}`);
  return buildAgentBootPrompt(agentName, { profile, unreadCount });
}

async function fetchBootPrompt(projectId: number, agentId: number): Promise<string | null> {
  const body = await fetchJson<Record<string, unknown>>(
    `${ACP_API_BASE}/v1/projects/${projectId}/boot-prompt/${agentId}`,
  );
  if (!body) return null;
  // Unwrap envelopes (acp-api success() + possibly the cloud's own) until
  // we reach the node carrying boot_prompt. Same nesting bug class as
  // fetchProject — don't assume one level.
  let node: any = body;
  for (let i = 0; i < 4 && node && typeof node === 'object' && !('boot_prompt' in node) && 'data' in node; i++) {
    node = (node as any).data;
  }
  let bp: any = node?.boot_prompt ?? node?.bootPrompt;
  // boot_prompt itself came back as an Object (crashed writeFileSync).
  // Pull the prompt string out of the common shapes; if we genuinely
  // can't, serialize it (agent still boots; identity also comes from the
  // "report as X" prompt + colonized .claude). Log the real shape so the
  // exact field can be pinned next.
  if (bp && typeof bp === 'object') {
    const o = bp as Record<string, unknown>;
    const picked = o.boot_prompt ?? o.content ?? o.text ?? o.prompt ?? o.system_prompt ?? o.value;
    bp = typeof picked === 'string' ? picked : JSON.stringify(bp, null, 2);
    console.warn(`[SpawnOrch] boot-prompt for agent=${agentId} was an object; keys=${JSON.stringify(Object.keys(o))} extracted=${typeof picked === 'string' ? 'string' : 'JSON-fallback'}`);
  }
  if (typeof bp === 'string' && bp.trim()) return bp;
  console.warn(`[SpawnOrch] boot-prompt for agent=${agentId} unusable; body=${JSON.stringify(body).slice(0, 400)}`);
  return null;
}

async function checkSpawnPredicates(projectId: number): Promise<{ ok: boolean; reason?: string }> {
  // Defensive guard: re-verify project is RUNNING before spawning.
  // The lifecycle event should only fire on RUNNING, but F1 regression
  // or event reordering can cause INCOMPLETE projects to reach here.
  const lcRes = await fetchJson<Record<string, unknown>>(
    `${ACP_API_BASE}/v1/projects/${projectId}/lifecycle`,
  );
  const lcData = (lcRes?.data ?? lcRes) as Record<string, unknown> | null;
  const lc = (lcData?.lifecycle ?? lcData) as Record<string, unknown> | null;
  const state = lc?.state as string | undefined;

  if (state !== 'RUNNING') {
    return { ok: false, reason: `project lifecycle state is '${state ?? 'unknown'}' (expected RUNNING)` };
  }
  return { ok: true };
}

async function orchestrateSpawn(projectId: number): Promise<void> {
  // Idempotent against connect/reconnect double-seed.
  if (seededProjects.has(projectId)) {
    console.log(`[SpawnOrch] project=${projectId} already seeded; skipping`);
    return;
  }

  // Skip if we already have agents spawned for this project (idempotent
  // against state-changed re-fires).
  if (spawnedByProject.has(projectId) && (spawnedByProject.get(projectId) ?? []).length > 0) {
    console.log(`[SpawnOrch] project=${projectId} already has spawned agents; skipping`);
    return;
  }

  console.log(`[SpawnOrch] orchestrating spawn for project=${projectId}`);

  const predicate = await checkSpawnPredicates(projectId);
  if (!predicate.ok) {
    console.error(`[SpawnOrch] PREDICATE_FAILED project=${projectId}: ${predicate.reason}`);
    return;
  }
  console.log(`[SpawnOrch] PREDICATE_PASS project=${projectId}: ready to spawn`);

  const [project, team] = await Promise.all([
    fetchProject(projectId),
    fetchTeam(projectId),
  ]);

  if (!project) {
    console.warn(`[SpawnOrch] project=${projectId} not found — aborting spawn`);
    return;
  }
  if (team.length === 0) {
    // Live-team model (WO-ACP-LIVE-TEAM-MERGE ACP-2): a project's roster IS
    // its engaged standing team's roster, read live — an EMPTY roster just
    // means NO team is engaged (HTTP 200, NOT an error) and is the DEFAULT
    // for fresh projects. This must be a renderer-visible state, not a
    // swallowed console line: push the typed event so projectStore surfaces
    // the "No team engaged — pick a team" CTA. Explicit engage only — no
    // auto-engage magic (locked decision).
    console.warn(`[SpawnOrch] project=${projectId} has no engaged team (empty roster) — aborting spawn; surfacing NO_TEAM_ENGAGED`);
    emitNoTeamEngaged({
      project_id: projectId,
      project_name: project.name,
      message: `Project "${project.name}" has no team engaged — engage a standing team to start its agents.`,
    });
    // Leave the RUNNING transition UNCONSUMED (the handler recorded it in
    // lastSeenState before dispatching here): a post-engage reseed re-emits
    // project-lifecycle-changed RUNNING and only re-fires orchestrateSpawn
    // when oldS !== 'RUNNING'. Deleting the marker lets that re-fire happen
    // once the user has engaged a team.
    lastSeenState.delete(projectId);
    return;
  }

  // ONE known workspace root for BOTH colonize and spawn. The value is
  // known — cloud project.repo_path, or its persisted handoff twin
  // settings.installerWorkspaceRoot (installerHandoff.ts writes it). We
  // NEVER infer (no process.cwd()/.. install-dir backstop — that was the
  // hole that spawned agents in ...\Programs). If genuinely neither is
  // set, that is a surfaced error — bail loudly, do not spawn anywhere.
  // NOTE (deferred wrinkle, to-do list): if a member declares a
  // work_dir_override different from the working/colonized folder it
  // won't work anyway — not reconciled here per Jon.
  const workspaceRoot = project.repo_path ?? getSettings().installerWorkspaceRoot ?? null;
  if (!workspaceRoot) {
    console.error(
      `[SpawnOrch] project=${projectId} has NO workspace root ` +
      `(repo_path + installerWorkspaceRoot both unset) — refusing to ` +
      `spawn (will not fall back to the install dir). Set the project repo path.`,
    );
    return;
  }

  // The workspace root is explicitly declared AND consent-recorded (the
  // installer handoff: colonizationConsented=true + workspaceRoot).
  // Materialize that consented directory if absent — creating the
  // declared workspace is the system doing its job, NOT guessing a value
  // (Jon's no-fallback law is about unset config, not about physically
  // making the folder we were told to use). Removes any dependency on the
  // (removed, crash-prone) install-time colonize exec: runtime now
  // create → colonize → spawn, idempotently, fresh machine included.
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (e) {
    console.error(`[SpawnOrch] could not create workspace root ${workspaceRoot}:`, e);
  }

  // COL-6 AC3 wire-in (spec §5): colonize the project workspace ONCE
  // before spawning the team, via the single colonizeWorkspace authority
  // (it re-resolves through resolveWorkDir; identity in, never a composed
  // path). Consent-first is a REAL recorded gate (spec §2.3/§8 AC7,
  // BAPert ruling msg 60): gated on the persisted colonizationConsent
  // flag — the installer's hard consent page (M5) records it for
  // end-users, a dev records it knowingly. Absent/false →
  // colonizeWorkspace returns 'skipped', NON-DESTRUCTIVE: agents still
  // spawn, just unscaffolded. NEVER a silent auto-mutate. colonize never
  // throws by contract; defensive catch keeps spawn 267-immune (spec §5).
  try {
    const cz = colonizeWorkspace(
      { repo_path: workspaceRoot, projectId, colonizationConsented: getSettings().colonizationConsent === true },
      { agents: team.map((m) => m.agent_name) },
    );
    console.log(`[SpawnOrch] colonize project=${projectId}: ${cz.status}${cz.notice ? ` — ${cz.notice}` : ''}`);
  } catch (e) {
    console.error('[SpawnOrch] colonize unexpected error (non-fatal, spawn continues):', e);
  }

  // Build data-driven boot prompts for the whole team up-front. A cloud
  // Wave-D boot prompt still wins when present, but every agent is now
  // guaranteed a code-generated onboarding prompt so we never depend on a
  // per-agent markdown file or the "report as" skill.
  let localBootPrompts: Map<string, string>;
  try {
    const prompts = await Promise.all(
      team.map((m) => buildLocalBootPrompt(m.agent_name).catch((err) => {
        console.warn(`[SpawnOrch] failed to build boot prompt for ${m.agent_name}:`, err);
        return buildAgentBootPrompt(m.agent_name);
      })),
    );
    localBootPrompts = new Map(team.map((m, i) => [m.agent_name, prompts[i]]));
  } catch (err) {
    console.warn('[SpawnOrch] unexpected error building boot prompts; falling back to synthesized-only:', err);
    localBootPrompts = new Map(team.map((m) => [m.agent_name, buildAgentBootPrompt(m.agent_name)]));
  }

  const records: SpawnedAgentRecord[] = [];

  for (const member of team) {
    // Skip if this agent already has a live session (PTY or ACP) in this
    // project. The dedup guard is scoped by (projectId, agentName) so two
    // projects can each have their own BAPert without collision.
    const existing = getAgentSessionByAgent(member.agent_name, projectId);
    if (existing) {
      console.log(`[SpawnOrch] ${member.agent_name} already has ${existing.kind.toUpperCase()} ${existing.id} in project=${projectId}; skipping orchestrator spawn`);
      continue;
    }

    // A missing cloud boot-prompt must NOT gate the spawn. Prefer the Wave-D
    // assembled prompt when the cloud provides one; otherwise use the locally
    // synthesized onboarding prompt (profile + unread mail pre-fetched from the
    // ACP API). This removes the dependency on per-agent markdown files and the
    // "report as" skill kickoff.
    const cloudBootPrompt = await fetchBootPrompt(projectId, member.agent_id);
    const localBootPrompt = localBootPrompts.get(member.agent_name) ?? buildAgentBootPrompt(member.agent_name);
    const bootPrompt = cloudBootPrompt?.trim() ? cloudBootPrompt.trim() : localBootPrompt;
    if (cloudBootPrompt?.trim()) {
      console.log(`[SpawnOrch] using cloud boot-prompt for ${member.agent_name}`);
    } else {
      console.log(`[SpawnOrch] using synthesized boot-prompt for ${member.agent_name}`);
    }

    // Workspace root = the colonized PROJECT root, period. Per-agent
    // work_dir_override is IGNORED (no per-agent editor yet → always null →
    // pure landmine). One authority: the project.
    const workDir = workspaceRoot;
    // Project-driven runtime (feedback_runtime_choice_vs_platform_llm):
    // the WHOLE team runs the project's single runtime_choice. Per-member
    // runtime_override (mixed-mode: different runtimes within one project)
    // is intentionally NOT applied — the backend doesn't support mixed
    // runtimes yet. The field/UI remain; the orchestrator just won't act
    // on it until the backend does. Only a recognized runtime is passed;
    // anything else → undefined. SPEC-team-runtime §3.3 (Jon re-scope):
    // since this is a project-scoped spawn (projectId set), an undefined
    // runtime makes spawnAgent THROW RuntimeNotSetError (caught below and
    // surfaced) — it does NOT fall back to the global agentProvider. The
    // global never masks an unset team runtime.
    const rawRuntime = project.runtime_choice || '';
    const runtime = (rawRuntime === 'claude' || rawRuntime === 'kimi' || rawRuntime === 'codex')
      ? rawRuntime
      : undefined;
    // Per-agent EFFORT override (effort_override) IS honored per-member —
    // deliberately UNLIKE runtime_override / work_dir_override above, which
    // stay project-uniform. Per Aurum 1401 + BAPert 1408: effort is a
    // legitimate per-agent cost/quality knob (lead 'high', QA 'low'),
    // whereas runtime must be a uniform CLI and work_dir is the colonized
    // root. Do NOT "consistency"-strip this citing the one-authority
    // comment above — that scope is runtime/work_dir only. Narrow to a
    // recognized level, else undefined so pty.ts defers to the SINGLE
    // global default (opts?.effort || settings.claudeEffort || 'high') —
    // no silent wrong value, no second authority. Claude-only: pty reads
    // effort solely in the claude branch, so this is ignored for kimi/codex.
    //
    // Narrowed by the SHARED guard, not a local list. This was a hand-written
    // `raw === 'low' || ... || raw === 'max'` chain that omitted 'xhigh', so a
    // stored xhigh silently became undefined = inherit — the picker offered a
    // level that could never reach the child. Do not re-inline the union here.
    const effort = narrowClaudeEffort(member.effort_override);
    // Per-agent MODEL override (WO-KIMI-MODEL-OVERRIDE): passed through RAW,
    // deliberately UNLIKE effort above. The spawn boundary validates the bare
    // id and throws ModelNotRecognizedError on anything unknown — narrowing
    // here would be exactly the silent-fallback-to-inherit the WO forbids.
    const modelOverride = member.model_override || undefined;
    // Effective runtime — used ONLY to decide the non-claude spawn stagger
    // below. SPEC-team-runtime §3.3 (Jon re-scope): NO global agentProvider
    // fallback here — the team runtime is the single authority. If runtime is
    // unset, spawnAgent throws RuntimeNotSetError (surfaced below), so this
    // value is moot in that case; treating undefined as non-kimi just skips
    // an unnecessary stagger before the block fires.
    const effectiveProvider = runtime;
    try {
      const terminalId = spawnAgent(member.agent_name, workDir, { bootPrompt, runtime, effort, modelOverride, projectId, agentId: member.agent_id });
      records.push({
        projectId,
        agentId: member.agent_id,
        agentName: member.agent_name,
        terminalId,
        spawnedAt: new Date().toISOString(),
      });
      console.log(`[SpawnOrch] spawned ${member.agent_name} → terminal=${terminalId} workDir=${workDir} effort=${effort ?? '(global default)'} project=${projectId}`);

      // Seed the sidecar's lifecycle state so /internal/pty/output can resolve
      // project_id/session_id for live SSE emission, and so the health monitor /
      // crash auto-restart path has the correct project mapping.
      // spawn-orchestrator bypasses the normal /v1/lifecycle/agents/:name/spawn
      // route, so BackoffManager is otherwise empty.
      try {
        await registerPtyTerminal({
          agentName: member.agent_name,
          terminalId,
          projectId,
          provider: runtime,
        });
        console.log(`[SpawnOrch] registered ${member.agent_name} terminal=${terminalId} with sidecar`);
      } catch (err) {
        console.warn(`[SpawnOrch] failed to register ${member.agent_name} with sidecar:`, err);
      }
    } catch (err) {
      // Orchestrator-path parity (SPEC-workdir-invalid §3.4): this path has
      // NO renderer fetch to catch the throw, so a bad project repo_path
      // (e.g. a macOS path opened on Windows) would be an orphaned main-side
      // failure. Narrowly convert WorkDirError into the typed PTY_SPAWN_FAILED
      // IPC so the SAME renderer surface renders. Do NOT widen: any other
      // (genuinely unexpected) error keeps the existing log-and-continue
      // behavior — it must not masquerade as WORKDIR_INVALID (criterion 10).
      if (err instanceof WorkDirError) {
        emitSpawnFailed({
          code: 'WORKDIR_INVALID',
          agent_name: err.agentName,
          work_dir: err.workDir,
          message: err.message,
        });
        console.error(`[SpawnOrch] WORKDIR_INVALID spawning ${member.agent_name}: ${err.message}`);
      } else if (err instanceof RuntimeNotSetError) {
        // SPEC-team-runtime §3.3: active project with no team runtime — BLOCK
        // (no silent default) and surface via the SAME typed IPC so the
        // renderer shows "team runtime not set." Orchestrator path has no
        // renderer fetch to catch the throw, same parity reason as workdir.
        emitSpawnFailed({
          code: 'RUNTIME_NOT_SET',
          agent_name: err.agentName,
          project_id: err.projectId,
          message: err.message,
        });
        console.error(`[SpawnOrch] RUNTIME_NOT_SET spawning ${member.agent_name}: ${err.message}`);
      } else {
        console.error(`[SpawnOrch] failed to spawn ${member.agent_name}:`, err);
      }
    }

    // Kimi/Codex first-run init writes the SHARED user-global config
    // (~/.kimi/kimi.json) via temp→atomic-rename. N near-simultaneous
    // starts race on that one file and one loses with WinError 5
    // (Access denied) — exactly the DotNetPert kimi failure. Claude has
    // no such shared init. Space non-claude spawns so each initializes
    // its config before the next starts.
    if (effectiveProvider !== 'claude') {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  if (records.length > 0) {
    spawnedByProject.set(projectId, records);
    seededProjects.add(projectId);
    console.log(`[SpawnOrch] project=${projectId} spawn complete: ${records.length}/${team.length} agents`);
  }
}

function orchestrateTeardown(projectId: number): void {
  const records = spawnedByProject.get(projectId);
  if (!records || records.length === 0) {
    console.log(`[SpawnOrch] no spawned agents to tear down for project=${projectId}`);
    return;
  }
  console.log(`[SpawnOrch] tearing down ${records.length} agents for project=${projectId}`);
  for (const rec of records) {
    try {
      void endAgentSession(rec.terminalId, 'teardown');
      killTerminal(rec.terminalId);
      console.log(`[SpawnOrch] killed ${rec.agentName} terminal=${rec.terminalId}`);
    } catch (err) {
      console.warn(`[SpawnOrch] failed to kill ${rec.agentName}:`, err);
    }
  }
  spawnedByProject.delete(projectId);
}

let unsubLifecycle: (() => void) | null = null;
const lastSeenState = new Map<number, LifecycleState>();
let isStarted = false;

export function startSpawnOrchestrator(): void {
  if (isStarted) return;
  isStarted = true;

  // Wave E Stage 7 — subscribe to project-lifecycle-changed via the
  // lifecycle-hub (SignalR push). Replaces the prior lifecycle-poller's
  // 'state-changed' event. Same orchestrate semantics — when state
  // transitions into RUNNING, spawn; out of RUNNING, teardown. The
  // hub's snapshot-on-connect fires the event at startup so initial
  // state is captured without extra REST round-trip.
  unsubLifecycle = onLifecycleHubEvent('project-lifecycle-changed', (...args) => {
    const event = args[0] as ProjectLifecycleChangedEvent;
    if (!event || typeof event.project_id !== 'number') return;
    const pid = event.project_id;
    const oldS = lastSeenState.get(pid) ?? null;
    const newS = event.state ?? null;

    // Track for next-event comparison.
    if (newS) lastSeenState.set(pid, newS);

    // Transition INTO RUNNING — orchestrate spawn for CURRENT project only.
    if (newS === 'RUNNING' && oldS !== 'RUNNING') {
      if (currentProjectId !== null && pid !== currentProjectId) {
        console.log(`[SpawnOrch] project=${pid} RUNNING but current project is ${currentProjectId}; ignoring`);
        return;
      }
      currentProjectId = pid;
      void orchestrateSpawn(pid);
      return;
    }

    // Transition OUT OF RUNNING (or PAUSED, also a teardown-worthy
    // state — agents stop, but the project pointer stays). PAUSED
    // resume re-orchestrates fresh-spawn on the next RUNNING transition.
    if (oldS === 'RUNNING' && newS !== 'RUNNING') {
      orchestrateTeardown(pid);
      return;
    }
  });

  console.log('[SpawnOrch] started — subscribed to lifecycle-hub events');
}

export function stopSpawnOrchestrator(): void {
  if (!isStarted) return;
  unsubLifecycle?.();
  unsubLifecycle = null;
  lastSeenState.clear();
  isStarted = false;
  currentProjectId = null;
  // Tear down all tracked spawns on shutdown. The OS / killAllPty would
  // also handle this, but explicit cleanup keeps the boot-prompt tmp
  // files from accumulating if shutdown is graceful.
  for (const projectId of Array.from(spawnedByProject.keys())) {
    orchestrateTeardown(projectId);
  }
  seededProjects.clear();
  console.log('[SpawnOrch] stopped');
}
