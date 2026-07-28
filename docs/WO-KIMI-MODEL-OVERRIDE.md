# WO: Per-Agent Kimi Model Selection (model_override)

**Status:** Ready for implementation
**Owners:** DotNetPert (VibeSQL + cloud API), Nextpert-Scout (idealvibe.online), NextPert (acp-api + acp-desktop)
**Reviewer:** QAPert
**Date:** 2026-07-17
**Requested by:** Nextpert-Scout (mails 11398/11408); prioritized + bare-id decision signed off by Jon

---

## Problem

Every spawned agent silently inherits `default_model` from `~/.kimi-code/config.toml` — nothing in the team-startup chain passes a model. The new kimi model landscape is live: **k3** (flagship, up to 1M ctx, reasoning_effort low/high/max), **kimi-for-coding** (K2.7, 256k), **kimi-for-coding-highspeed** (~5-6x output, 3x quota). We want per-agent model selection driven from team definitions in idealvibe.online.

Startup priority per official docs: `-m <alias>` flag > `KIMI_MODEL_*` env > `default_model` in config.toml.

## Locked decisions (Jon-signed, do not re-litigate)

- Store the **bare model id** (`k3` | `kimi-for-coding` | `kimi-for-coding-highspeed`) in the DB; acp-desktop maps bare id → alias (`kimi-code/<id>`) at spawn. The `kimi-code/` prefix is a local config artifact.
- Per-placement override; **null = inherit** default_model. No mid-session switching — fresh session per spawn already satisfies the docs' cache-invalidation guidance.
- K3 effort rides `effort_override`, injected as `KIMI_MODEL_THINKING_EFFORT` env at spawn (no CLI flag exists).
- 401 on k3/highspeed/1M = plan entitlement error — **surface it, do not retry.**
- Mistyped/unknown model ids must **fail loud at spawn** — the highspeed id silently falls back to standard with no error; that failure mode is unacceptable.

## Scope by layer

### 1. VibeSQL + cloud API — DotNetPert
- Nullable `model_override` on the per-placement team-membership table (same pattern as `runtime_override`; consider an agents-table default as well — your call, document it). **Update (live-team merge, 2026-07-24):** the source table is now `team_agent_instances` — overrides live on the standing team's instances and follow the team across projects (a project's roster is its engaged team's roster, read live). Field names unchanged.
- Expose on `ProjectTeamMemberDto` GET/PATCH.

### 2. idealvibe.online — Nextpert-Scout (his request, his layer)
- `ProjectTeamMember.model_override` in `lib/projects/types.ts`; patch passthrough in `lib/agents/useProjectTeam.ts`.
- Model picker in the per-member override editor (`components/agents/workshop/TeamPage.tsx`): show only when the effective runtime is kimi; constrain choices to the 3 known IDs.
- Fix stale comment at `types.ts:181-184`: `effort_override` says kimi has no effort lever — k3 takes low/high/max.

### 3. acp-api — NextPert
- `mapper.ts`: `CloudProjectTeamMemberDto` must carry `effort_override` + `model_override` through to the wire (effort passthrough is already missing today — same fix).
- `safeChildEnv.ts`: strips `KIMI_*` env from spawned contractor children — add `KIMI_` to `VENDOR_PREFIXES` if the `KIMI_MODEL_*` channel must reach contractor children (decide + document either way).

### 4. acp-desktop — NextPert
- `src/main/acp/providerConfigs.ts`: kimi spawn model-aware — append `-m <alias>` to `acpCommand`/`ptyCommand` when the agent has `model_override`.
- Validate the alias against the models table at spawn and **fail loud** on unknown ids.
- Inject `KIMI_MODEL_THINKING_EFFORT` when `effort_override` is set on k3.

## Acceptance criteria

1. A team member with `model_override=kimi-for-coding-highspeed` spawns with `-m kimi-code/kimi-for-coding-highspeed` (verified via spawned command line / main-process log).
2. Null override → current behavior byte-identical (inherits default_model).
3. Invalid/mistyped id → loud spawn-time error; never a silent fallback.
4. k3 + `effort_override=high` → spawned env carries `KIMI_MODEL_THINKING_EFFORT=high`.
5. Entitlement 401 surfaces as a clear user-visible error; no retry storm.
6. Picker offers only the 3 known IDs and only for kimi runtime members.
7. Tests per each repo's conventions; QAPert verifies the chain end-to-end.

## Sequencing

DNP's column + DTO first (it's the contract), then acp-api / acp-desktop / idealvibe.online in parallel. Estimates: DNP ~0.5d, Scout ~0.5–1d, NextPert ~1d.

## References

- Scout's design mails 11398 + 11408 (locked decisions verbatim).
- https://www.kimi.com/code/docs/en/kimi-code/models (+ kimi-command / config-files / env-vars under the same docs root).
