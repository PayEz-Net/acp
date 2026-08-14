#!/usr/bin/env node
/**
 * 117431 / 121194 LIVE ACCEPTANCE PROBE — run against a deployed acp-api AFTER the quiet-window
 * deploy. Every leg is independent: one green does not imply another (BAPert's note: scoping
 * and paging need TWO acceptance checks). Red controls included — a probe that has never
 * failed proves nothing.
 *
 * Usage:
 *   node scripts/verify-117431.mjs [--base http://127.0.0.1:3001] [--agent Nextpert-Scout] \
 *        [--bearer <ACP_LOCAL_SECRET>] [--project-a 31] [--project-b 12]
 *
 * Legs:
 *   1. SCOPING: POST /v1/projects/{B}/kanban/tasks lands on B (counter-example: probe card
 *      204645, created with project_id=12 pre-fix, sits on 31 forever).
 *   2. REJECTION: ?project_id= on the legacy list/create 400s (pre-fix it 200/201'd and
 *      silently used the active project).
 *   3. PAGING: ?limit=5&offset=0 vs ?limit=5&offset=50 return DISTINCT 5-row pages
 *      (pre-fix: identical full table, 552+ rows, same first id).
 *   4. GATE (bearer only): /v1/projects/{bad}/kanban/tasks read -> 404, write -> 403.
 *      RED CONTROL: agent-identity caller BYPASSES (Ruling A) — same request with
 *      X-ACP-Agent must NOT 404/403. If the bypass leg 404s, the gate over-fires.
 *   5. MOVE: moves the throwaway card A->B->A via PUT /v1/kanban/tasks/:id/move and
 *      re-reads projectId after each leg (verify the EFFECT, not the call).
 *
 * Exit 0 = all legs green. Any red exits 1 naming the leg. Cleans up its own probe card.
 */
const args = process.argv.slice(2);
function arg(name, dflt) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; }
const BASE = arg('--base', 'http://127.0.0.1:3001');
const AGENT = arg('--agent', 'Nextpert-Scout');
const BEARER = arg('--bearer', process.env.ACP_LOCAL_SECRET || null);
const PROJECT_A = Number(arg('--project-a', '31'));
const PROJECT_B = Number(arg('--project-b', '12'));

let failures = 0;
const ok = (leg, msg) => console.log(`  GREEN ${leg}: ${msg}`);
const red = (leg, msg) => { failures++; console.log(`  RED   ${leg}: ${msg}`); };

async function call(method, path, { body, auth = 'agent' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth === 'agent') headers['X-ACP-Agent'] = AGENT;
  if (auth === 'bearer') headers['Authorization'] = `Bearer ${BEARER}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* envelope may be absent on raw 404s */ }
  return { status: res.status, json };
}

console.log(`117431/121194 live acceptance against ${BASE} (A=${PROJECT_A}, B=${PROJECT_B}, agent=${AGENT}, bearer=${BEARER ? 'set' : 'UNSET — gate legs skip'})`);

// ── Leg 2 (rejection) first: cheapest, no writes ─────────────────────────────
{
  const list = await call('GET', `/v1/kanban/tasks?project_id=${PROJECT_B}`);
  if (list.status === 400 && /projects\/\{id\}\/kanban\/tasks/.test(list.json?.error?.message || '')) ok('REJECT-list', '?project_id= 400s naming the path shape');
  else red('REJECT-list', `expected 400 naming the path shape, got ${list.status} ${JSON.stringify(list.json?.error?.message || '')}`);

  const create = await call('POST', '/v1/kanban/tasks', { body: { title: 'PROBE 117431 reject leg — must not exist', project_id: PROJECT_B } });
  if (create.status === 400) ok('REJECT-create', 'create with project_id 400s');
  else red('REJECT-create', `expected 400, got ${create.status} — CHECK THE BOARD for a card titled 'PROBE 117431 reject leg'`);
}

// ── Leg 3 (paging): distinct pages, independent of scoping ──────────────────
{
  const p1 = await call('GET', '/v1/kanban/tasks?limit=5&offset=0');
  const p2 = await call('GET', '/v1/kanban/tasks?limit=5&offset=50');
  const ids1 = (p1.json?.data || []).map(t => t.id);
  const ids2 = (p2.json?.data || []).map(t => t.id);
  const meta = p1.json?.meta?.pagination;
  if (ids1.length === 5 && ids2.length === 5 && ids1[0] !== ids2[0] && meta?.total > 50 && meta?.has_more === true) {
    ok('PAGING', `page1 [${ids1[0]}..] != page2 [${ids2[0]}..], total=${meta.total}`);
  } else {
    red('PAGING', `page1=${JSON.stringify(ids1)} page2=${JSON.stringify(ids2)} meta=${JSON.stringify(meta)}`);
  }
  const garbage = await call('GET', '/v1/kanban/tasks?limit=abc');
  if (garbage.status === 400) ok('PAGING-garbage', 'limit=abc 400s');
  else red('PAGING-garbage', `expected 400, got ${garbage.status}`);
}

// ── Leg 1 (scoping): create on B lands on B; 204645 is the standing counter-example ──
let probeId = null;
{
  const counter = await call('GET', '/v1/kanban/tasks/204645');
  if ((counter.json?.data?.projectId) === PROJECT_A) ok('COUNTER-EXAMPLE', '204645 still on 31 (pre-fix misfile preserved as fixture)');
  else red('COUNTER-EXAMPLE', `204645 projectId=${counter.json?.data?.projectId} (expected ${PROJECT_A}) — was it moved/deleted before close-out?`);

  const created = await call('POST', `/v1/projects/${PROJECT_B}/kanban/tasks`, { body: { title: 'PROBE 117431 path-scoped create — auto-deleted by probe', priority: 'low' } });
  probeId = created.json?.data?.id ?? null;
  if (!probeId) {
    red('SCOPING-create', `create on ${PROJECT_B} failed: ${created.status} ${JSON.stringify(created.json?.error || '')}`);
  } else {
    // verify the EFFECT: the card must be readable under B and INVISIBLE under A's board list
    const viaB = await call('GET', `/v1/projects/${PROJECT_B}/kanban/tasks/${probeId}`);
    const listA = await call('GET', '/v1/kanban/tasks?limit=5000');
    const onA = (listA.json?.data || []).some(t => t.id === probeId);
    if (viaB.status === 200 && !onA) ok('SCOPING', `card ${probeId} readable under project ${PROJECT_B}, absent from active board`);
    else red('SCOPING', `viaB=${viaB.status} onActiveBoard=${onA}`);
  }
}

// ── Leg 5 (move): A->B->A, re-read after each leg ────────────────────────────
if (probeId) {
  // move probe B->A (probe was created on B above)
  const toA = await call('PUT', `/v1/kanban/tasks/${probeId}/move`, { body: { project_id: PROJECT_A } });
  const readA = await call('GET', `/v1/kanban/tasks/${probeId}`);
  if (toA.status === 200 && readA.json?.data?.projectId === PROJECT_A) ok('MOVE B->A', `card ${probeId} re-reads projectId=${PROJECT_A}`);
  else red('MOVE B->A', `move=${toA.status} re-read projectId=${readA.json?.data?.projectId}`);

  const toB = await call('PUT', `/v1/kanban/tasks/${probeId}/move`, { body: { project_id: PROJECT_B } });
  const viaB = await call('GET', `/v1/projects/${PROJECT_B}/kanban/tasks/${probeId}`);
  if (toB.status === 200 && viaB.status === 200) ok('MOVE A->B', `card ${probeId} readable under ${PROJECT_B} again`);
  else red('MOVE A->B', `move=${toB.status} viaB=${viaB.status}`);

  // move back to A + archive for cleanup
  await call('PUT', `/v1/kanban/tasks/${probeId}/move`, { body: { project_id: PROJECT_A } });
  await call('POST', `/v1/kanban/tasks/${probeId}/archive`);
  console.log(`  (probe card ${probeId} moved back to ${PROJECT_A} and archived)`);
}

// ── Leg 4 (gate): bearer denied on a project the session user cannot see ─────
// NOTE: needs a project id the session user genuinely CANNOT see — that is the fixture
// (Ruling B). Until the fixture user/project exists, run with --gate-project <id> only
// when you have one; otherwise this leg SKIPS loudly (a skip is not a pass).
const GATE_PROJECT = Number(arg('--gate-project', '0'));
if (!BEARER || !GATE_PROJECT) {
  console.log('  SKIP  GATE: needs --bearer AND --gate-project <a project the session user cannot see> (fixture, Ruling B). A skip is not a pass.');
} else {
  const readDenied = await call('GET', `/v1/projects/${GATE_PROJECT}/kanban/tasks`, { auth: 'bearer' });
  if (readDenied.status === 404) ok('GATE-read', `bearer read of invisible project ${GATE_PROJECT} -> 404`);
  else red('GATE-read', `expected 404, got ${readDenied.status}`);

  const writeDenied = await call('POST', `/v1/projects/${GATE_PROJECT}/kanban/tasks`, { auth: 'bearer', body: { title: 'PROBE gate write — must not exist' } });
  if (writeDenied.status === 403) ok('GATE-write', `bearer write to invisible project -> 403`);
  else red('GATE-write', `expected 403, got ${writeDenied.status}`);

  // RED CONTROL: the same two calls as an AGENT caller must NOT be denied (Ruling A bypass).
  // If this leg reds, the gate over-fires and blocks the whole team's tooling.
  const agentRead = await call('GET', `/v1/projects/${GATE_PROJECT}/kanban/tasks`, { auth: 'agent' });
  if (agentRead.status !== 404 && agentRead.status !== 403) ok('GATE-bypass-control', `agent caller bypasses (status ${agentRead.status})`);
  else red('GATE-bypass-control', `agent caller got ${agentRead.status} — the gate is eating agent traffic, Ruling A violated`);
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} LEG(S) RED`);
process.exit(failures === 0 ? 0 : 1);
