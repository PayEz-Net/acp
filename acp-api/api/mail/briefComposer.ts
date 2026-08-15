/**
 * Mail brief composer — N messages into one action brief, via a LOCAL model.
 *
 * WHY THIS EXISTS. Per-message mail push cost one agent turn per message, and
 * every turn reloads that agent's whole session context: ~2.3M tokens on a
 * heavy cycle, a week of quota in four hours (see
 * a_very_important_hard_lesson_learned_about_ai_rigs.md in the repo root). Agents now
 * receive mail as ONE summarised brief instead of N interrupts.
 *
 * WHY IT LIVES HERE and not in the router script. It has two callers — the
 * push loop (scripts/project-briefer.py) and the agent's own on-demand pull
 * (POST /v1/mail/brief/:agent). Two copies of a summariser drift, and the
 * drifted one is the one nobody is watching. One composer, both paths.
 *
 * The model is local (Ollama) on purpose: watching and summarising must never
 * be the most expensive thing on the rig, so this costs zero account tokens.
 */

const OLLAMA_URL = (process.env.KB_OLLAMA_URL || 'http://10.0.0.220:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.BRIEFR_MODEL || 'qwen2.5-coder:7b';
const OLLAMA_TIMEOUT_MS = 120_000;

/** Bound one message's body. A brief is a prompt; unbounded input is the
 *  context blowout this whole mechanism exists to prevent. */
const BODY_CHARS = 700;
/**
 * Most messages one brief will describe.
 *
 * EXPORTED because the caller must slice to it BEFORE marking anything read.
 * This module silently `slice()`d past the cap while the route marked the whole
 * batch read — so message 26+ of a burst would be marked read having never
 * appeared in any brief. Nobody would ever see them again. The cap is a limit
 * on how much one brief can usefully say, NOT permission to drop mail: the
 * overflow stays unread and arrives in the next brief.
 */
export const MAX_MAILS_SUMMARISED = 25;

export interface BriefMessage {
  message_id?: number;
  inbox_id?: number;
  from_agent?: string;
  subject?: string;
  body?: string;
}

export interface ComposedBrief {
  /** The notice text to hand the agent. */
  text: string;
  /** False when the local model was unreachable or produced garbage and the
   *  brief degraded to a labelled raw list. */
  modelOk: boolean;
}

/**
 * Did the local model return garbage rather than a summary?
 *
 * A degenerate brief is WORSE than none: it is presented to the agent as its
 * mail, so the agent acts believing it has been told something. Measured on
 * this rig — a 7b model answering a long prompt with a line of '@@@@@@@@'.
 */
export function isDegenerate(text: string): boolean {
  const body = text.replace(/\s/g, '');
  if (body.length < 40) return true;
  const alnum = (body.match(/[a-zA-Z0-9]/g) || []).length;
  if (alnum / body.length < 0.55) return true;
  const counts = new Map<string, number>();
  for (const ch of body) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / body.length > 0.3;
}

/**
 * Cut a summary at its first long repetition run.
 *
 * WHY THIS IS SEPARATE FROM isDegenerate: that function measures the whole
 * string — alnum ratio, max single-character frequency — and so only sees
 * WHOLESALE collapse. On 2026-08-14 a brief reached BAPert that was 600
 * characters of correct action items followed by a 31-character run of '@'.
 * Globally the run is ~5% of the body, under every threshold, and the gate
 * passed it. A model can degenerate at the END of an otherwise good answer,
 * and a check built on aggregates is structurally blind to that.
 *
 * Truncate rather than reject: the good half of a brief is worth delivering,
 * and rejecting would drop it in favour of a raw subject list. Announce the
 * cut — an agent acting on a silently shortened list would not know what it
 * was missing.
 */
export function stripRepetitionRun(text: string): { text: string; truncated: boolean } {
  const m = /(.)\1{7,}/.exec(text);
  if (!m) return { text, truncated: false };
  const head = text.slice(0, m.index).trimEnd();
  if (head.length < 120) return { text: head, truncated: true };
  return {
    text: `${head}\n\n[brief truncated: the summariser emitted a repetition run. Read your unread mail directly if this looks incomplete.]`,
    truncated: true,
  };
}

function renderMails(mails: BriefMessage[]): string {
  return mails.slice(0, MAX_MAILS_SUMMARISED).map((m) => {
    let body = String(m.body ?? '').trim();
    if (body.length > BODY_CHARS) body = `${body.slice(0, BODY_CHARS)} ...(truncated)`;
    return `[id ${m.message_id ?? '?'}] FROM ${m.from_agent ?? '?'} | ${m.subject ?? '(no subject)'}\n${body}`;
  }).join('\n\n---\n\n');
}

async function callOllama(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        // num_ctx must be explicit — Ollama's default context is far smaller
        // than a 25-message prompt, and an over-long prompt comes back as a
        // bare HTTP 500 (measured: it silently killed the two biggest inputs).
        options: { num_ctx: 8192, temperature: 0.2 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);
    const data = await res.json() as { response?: string };
    return (data.response ?? '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarise a batch into an action brief.
 *
 * Degrades to a labelled raw list rather than throwing: mail delivery must not
 * depend on a summariser being healthy, and a brief that SAYS it is degraded is
 * honest where a silently dropped one is not.
 */
export async function summariseMails(agent: string, mails: BriefMessage[]): Promise<{ summary: string; modelOk: boolean }> {
  // The budget SCALES WITH THE BATCH. A flat cap was the same 200 words whether the
  // batch was 2 messages or 18, so a busy agent's brief got compressed hardest at
  // exactly the moment it carried the most decisions — the failure is invisible,
  // because a 200-word summary of 18 messages reads perfectly well and simply
  // omits things. Floor keeps a 1-2 message brief from being padded into a report.
  const wordBudget = Math.min(400, Math.max(120, mails.length * 35));

  const prompt =
    `You are briefing ${agent}, a software agent returning to their inbox after ` +
    `heads-down work. Turn these ${mails.length} messages into ONE action brief.\n\n` +
    'Rules:\n' +
    '- Lead with what must be DONE, most urgent first. Group by sender where it helps.\n' +
    '- Name the sender and the message id for anything that needs a reply.\n' +
    '- Keep decisions and blockers; drop pleasantries, acks and status noise.\n' +
    '- If nothing needs action, say so in one line.\n' +
    `- No preamble, no sign-off. Under ${wordBudget} words.\n\n` +
    `MESSAGES:\n${renderMails(mails)}`;

  // RETRY, because the observed failure is TRANSIENT and undiagnosed.
  //
  // 2026-08-14: a brief to the observer came back as the raw-list fallback. The
  // model was up and answering, but returned a run of '@' to a trivial prompt —
  // and the response carried `done:false` on a NON-STREAMING call, which is a
  // generation that broke mid-flight rather than a model emitting bad tokens.
  // Two root-cause theories (num_ctx too large; VRAM contention with the
  // embedder) were each tested and FALSIFIED — the exact failing conditions were
  // reproduced deliberately and produced clean output.
  //
  // So this is not a fix for a known cause. It is a second roll of a die that
  // came up bad once, and it is worth taking because the cost of one bad roll is
  // an agent losing its ENTIRE brief to a raw subject list. Deliberately small:
  // if two consecutive attempts both degenerate, something real is wrong and the
  // honest fallback should fire rather than the caller stalling on retries.
  // BACK OFF BETWEEN ATTEMPTS — measured 2026-08-15, a defect in the first cut
  // of this retry. AbortController stops US waiting; it does NOT stop Ollama
  // generating. A retry fired the instant the client gave up therefore arrives
  // while the model is still busy with the previous prompt and comes back
  // `ollama HTTP 500`. Observed live: attempt 1 aborted at the 120s ceiling,
  // attempt 2 500'd immediately, and QAPert-NightHawk got a raw list for nine
  // messages — one slow generation turned into two failures by the retry meant
  // to rescue it. The pause lets the server finish and clear.
  const ATTEMPTS = 2;
  const RETRY_BACKOFF_MS = 15_000;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    try {
      const raw = await callOllama(prompt);
      // Strip a corrupted tail BEFORE judging the whole, so a good answer with a
      // bad ending is salvaged instead of thrown away.
      const { text, truncated } = stripRepetitionRun(raw ?? '');
      if (truncated) {
        console.warn(`[mailBrief] ${agent}: model emitted a repetition run — brief truncated at ${text.length} chars`);
      }
      if (text && !isDegenerate(text)) {
        if (attempt > 1) console.warn(`[mailBrief] ${agent}: recovered on attempt ${attempt}`);
        return { summary: text, modelOk: true };
      }
      console.warn(`[mailBrief] ${agent}: local model returned ${raw ? 'degenerate' : 'empty'} output (attempt ${attempt}/${ATTEMPTS})`);
    } catch (err: any) {
      console.warn(`[mailBrief] ${agent}: summariser unreachable (${OLLAMA_MODEL} @ ${OLLAMA_URL}): ${err.message} (attempt ${attempt}/${ATTEMPTS})`);
    }
  }

  // Every attempt failed. This line is the WATCHDOG'S HOOK — scripts/summariser-watch.sh
  // greps for this exact token, so the operator learns from a monitor rather than
  // from an agent receiving a degraded brief. Do not reword it without updating that.
  console.error(`[mailBrief] SUMMARISER_DOWN agent=${agent} mails=${mails.length} model=${OLLAMA_MODEL} url=${OLLAMA_URL}`);

  const raw = mails
    .map((m) => `- [id ${m.message_id ?? '?'}] ${m.from_agent ?? '?'}: ${m.subject ?? '(no subject)'}`)
    .join('\n');
  return { summary: `SUMMARISER DOWN - raw list, read these yourself:\n${raw}`, modelOk: false };
}

/**
 * The notice an agent actually receives. Self-instructing, like the renderer's
 * mail notice: an agent that has to ask the human what to do with a brief has
 * cost the turn this mechanism was saving.
 */
export function buildBriefText(agent: string, mails: BriefMessage[], summary: string, apiBase: string): string {
  const ids = mails.map((m) => m.message_id ?? '?').join(', ');
  return (
    `[ACP Mail Brief] ${mails.length} message(s) arrived while you were working ` +
    `(ids: ${ids}). Batched into one brief so your turn was not interrupted.\n\n` +
    `${summary}\n\n` +
    `Act on it now - do not wait for the human. Reply to anything that needs an ` +
    `answer with POST ${apiBase}/v1/mail/send as ${agent}. ` +
    `Full text of any message: GET ${apiBase}/v1/mail/messages/<id>.`
  );
}

export async function composeBrief(agent: string, mails: BriefMessage[], apiBase: string): Promise<ComposedBrief> {
  const { summary, modelOk } = await summariseMails(agent, mails);
  return { text: buildBriefText(agent, mails, summary, apiBase), modelOk };
}
