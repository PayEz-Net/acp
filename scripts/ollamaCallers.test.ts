/**
 * THE num_ctx RULE, AS A TEST THAT CAN ACTUALLY FAIL.
 *
 * docs/LOCAL-MODEL-TUNING.md has one load-bearing rule: every Ollama caller on
 * this box must request the SAME num_ctx (8192), because Ollama keys a loaded
 * model instance by (model, context size) and a disagreeing caller evicts the
 * others on an 8GB card.
 *
 * The rule was broken twice in one day (2026-08-15) and the suite stayed green
 * through both, because vitest does not reach shell or python callers. The Mac
 * team caught the second one by reading source; nothing automated could have.
 * 644 tests passed identically with the defect present and absent — which makes
 * those 644 a guard that cannot fire on the thing most likely to break here.
 *
 * WHAT MAKES THIS SUBTLE, and why "does the file say 8192" is not enough:
 * `options` is a NATIVE Ollama field. The OpenAI-compatibility endpoint
 * (/v1/chat/completions) accepts the request, returns a normal answer, and
 * SILENTLY DISCARDS options — so a caller can carry a textually perfect
 * num_ctx: 8192 while loading the model at its 32768 default. Both real
 * regressions looked correct in source. The endpoint is the tell, so this
 * checks the endpoint AND the value together.
 *
 * MEASURED COST of the bootbrief instance of this bug: one call took the card
 * from three resident models to one, evicting the spotter's 1.5b AND
 * nomic-embed-text. No embedder means kb recall and every kb write stop, and
 * nothing in that failure names a boot brief.
 *
 * This is a static check on purpose. It runs with no GPU, no network, and no
 * Ollama, so it fires in CI on a machine that has never seen the model. It does
 * NOT replace `ollama ps` — the doc is right that runtime is the real evidence.
 * It catches the regression that put us in front of `ollama ps` in the first
 * place.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

/** Every caller that talks to Ollama for GENERATION. */
const CALLERS = [
  'acp-api/api/mail/briefComposer.ts',
  'scripts/shutdown-with-summaries.py',
  'scripts/summariser-watch.sh',
  'scripts/brief/bootbrief.sh',
  'scripts/spotter/spot.sh',
];

/**
 * The compat shim, matched only where it is actually CALLED.
 *
 * The warning comments left behind by both fixes name this path deliberately —
 * they are how the next person learns the trap. Matching them would make this
 * test fail on its own documentation, so require the URL to be preceded by a
 * host expression (`$OLLAMA`, a quote, or `}`) rather than prose.
 */
const CALLS_COMPAT = /(?:\$\{?[A-Za-z_]\w*\}?|["'`])\/v1\/chat\/completions/;

/**
 * `num_ctx: 8192` in any of the four spellings this repo actually uses.
 *
 * TOLERATE BACKSLASH-ESCAPED QUOTES. summariser-watch.sh builds its JSON inside
 * a double-quoted shell string, so the literal bytes are `\"num_ctx\":8192`.
 * The first cut of this regex allowed a single unescaped quote and duly failed
 * a caller that was correct — a guard's first act was a false accusation, which
 * is how guards get switched off. Covered spellings:
 *     "num_ctx": 8192      (TS/JSON)
 *     'num_ctx': 8192      (python dict)
 *     \"num_ctx\":8192     (JSON inside a shell double-quoted string)
 *     num_ctx=8192         (bare)
 */
const NUM_CTX_8192 = /num_ctx\\?["']?\s*[:=]\s*8192/;
const NUM_CTX_ANY = /num_ctx\\?["']?\s*[:=]\s*(\d+)/g;

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('every Ollama caller agrees on num_ctx 8192 (LOCAL-MODEL-TUNING.md)', () => {
  it('the caller list is real — a renamed file must fail here, not be skipped', () => {
    const missing = CALLERS.filter((f) => !existsSync(join(ROOT, f)));
    expect(missing, `listed callers not found (rename? then update this list): ${missing.join(', ')}`)
      .toEqual([]);
  });

  it.each(CALLERS)('%s requests num_ctx 8192', (rel) => {
    const src = read(rel);
    expect(NUM_CTX_8192.test(src), `${rel} does not request num_ctx 8192`).toBe(true);
  });

  it.each(CALLERS)('%s does not send options to the compat endpoint', (rel) => {
    const src = read(rel);
    expect(
      CALLS_COMPAT.test(src),
      `${rel} CALLS /v1/chat/completions — the OpenAI-compat shim silently DISCARDS `
      + `options.num_ctx, so its 8192 is decorative and the model loads at its 32768 `
      + `default. Use a native endpoint (/api/chat or /api/generate); note num_predict `
      + `replaces max_tokens, temperature moves inside options, and the answer is at `
      + `.message.content (chat) or .response (generate).`,
    ).toBe(false);
  });

  it('no caller carries a num_ctx other than 8192', () => {
    const offenders: string[] = [];
    for (const rel of CALLERS) {
      for (const m of read(rel).matchAll(NUM_CTX_ANY)) {
        if (m[1] !== '8192') offenders.push(`${rel}: num_ctx ${m[1]}`);
      }
    }
    expect(offenders, `mismatched num_ctx — these evict each other on one card: ${offenders.join('; ')}`)
      .toEqual([]);
  });
});
