# WO — vsql-vault container: recurring PoolTimedOut (infra triage)

**WO ID:** WO-VSQL-VAULT-POOLTIMEDOUT-20260727
**Author:** BAPert (from DotNetPert's Graylog finding, flagged in mail id 1470)
**Date:** 2026-07-27
**Status:** CLOSED (dev) 2026-07-27 — soak compressed by Jon's decision; evidence in §8
**Owner:** DotNetPert (reassign if infra belongs elsewhere)
**Environment:** dev (observed); check prod before promotion

---

## 1. Problem

The vsql-vault container logs `PoolTimedOut` roughly every ~35 s — 830+
occurrences on 2026-07-27 alone — and continued after the 14:21Z redeploy
that fixed the agentmail tenant-context defect
(WO-MAIL-SEND-PROJECT-NOT-FOUND-20260727). Unrelated to that fix; flagged by
DotNetPert as a separate open issue.

## 2. Why it matters

- A pool that times out on a steady cadence suggests connection leakage or
  undersized pooling on the vsql query lane — the same lane whose failure
  masked today's mail-send outage. If it exhausts under load, query-lane
  consumers (agentmail, projects, sessions) fail in ways we have already
  seen mask as misleading error codes.
- Even if currently benign, 830+/day of error noise drowns real signals in
  Graylog (it partially obscured today's root-cause read).

## 3. Scope

1. Identify which component holds the pool (vsql-vault sidecar vs vault
   client vs query-lane proxy) and whether timeouts correlate with specific
   upstream calls.
2. Determine leak vs sizing: connections checked out and never returned, or
   pool max simply too small for the cadence.
3. Fix or tune; if genuinely benign (e.g. idle reaper noise), downgrade the
   log level and document why.

### Out of scope
- The agentmail tenant-context fix (done, df4a811a5).

## 4. Acceptance criteria

1. Zero `PoolTimedOut` in Graylog for vsql-vault over a 24 h window on dev —
   or a written, reviewed explanation of why the events are benign plus log
   noise reduced to non-error level.
2. No increase in query-lane 500s (`TENANT_CONTEXT_REQUIRED`,
   `SCHEMA_REQUIRED`, `VIBE_UNHANDLED_EXCEPTION`) after the change.
3. Finding noted back on this WO before any prod promotion of the affected
   container.

---

| Role | Agent | Status |
|---|---|---|
| WO author | BAPert | ✅ Authored 2026-07-27 |
| Triage + fix | DotNetPert | ✅ Triage 2026-07-27 (findings below) — fix blocked on container access / retire-vs-fix decision |

---

## 5. Triage findings (DotNetPert, 2026-07-27)

1. **Pool location: inside the vsql-vault container itself.** The container's
   entire Graylog output is `Error: PoolTimedOut` (Rust; shape matches a sqlx
   `PoolTimedOut` printed via `Debug`). Not the query lane, not the .NET
   `VaultClient` — zero vault-related errors from any other container in 24h.
2. **Chronic, not merge fallout.** 17,427 occurrences in the last 7 days,
   steady ~34.7s cadence since at least 2026-07-20 (oldest record in window).
3. **Pattern = dead/exhausted pool, not load.** Period ≈ 30s pool-acquire
   timeout + immediate retry ≈ 34.7s → a single persistent internal task
   continuously failing to acquire a connection. There is no concurrent load:
   nothing calls the vault on dev (next point).
4. **No callers, no user-facing impact on dev.** Dev stack in Graylog =
   PayEz.Vibe.Public.Api, PayEz.Encryption.Api, VibeSQL.Server,
   PayEz.External.Identity.Api, vsql-vault. The vault's only known consumer
   (PayEz.Payment.Api via `VaultClient` → `VsqlVaultSettings.BaseUrl`
   `http://10.0.0.93:8420`) is not deployed here, and :8420 refuses TCP
   connections from the LAN (curl exit 7, all probe paths).
5. **Vault server source is not on this machine.** PayEz-Core contains only
   the .NET client (`VaultClient.cs`, `VsqlVaultSettings.cs`,
   `PayEz.VibeSqlVault.Api`) and no `PoolTimedOut` string; the running
   container is a single Rust binary (`/vsql-vault --config
   /etc/vsql-vault/vsql-vault.toml`).

**Conclusion:** worst-case reading is an idle/legacy container whose DB pool
died (creds/SSL/endpoint drift after DB changes) and has been retry-looping
for a week. Noise-only on dev today. To close out per acceptance criteria we
need one of:

- **Retire**: if the vault lane is superseded on dev, stop/remove the
  container → zero PoolTimedOut (criterion 1).
- **Fix**: container access on jondeb (`docker inspect vsql-vault`, config
  `/etc/vsql-vault/vsql-vault.toml`, full `docker logs`) + the Rust source to
  repair DB connectivity, or downgrade the loop's log level with a documented
  benign justification (criterion 1 alternative).

Decision + access needed from Jon. No prod promotion of this container until
then (criterion 3).
Decision + access needed from Jon. No prod promotion of this container until
then (criterion 3).

---

## 6. Decision & plan (Jon, 2026-07-27)

**Decision: do NOT retire — the vault lane is required on dev. Stripe testing
later today depends on it.** Instead: stop the bleed now, fix the DB
connectivity today, bring it back healthy before testing starts.

1. **Stop now (relief):** stop the `vsql-vault` container on jondeb to end
   the retry-loop resource drag on the low-power dev box
   (`docker stop vsql-vault`). Owner: Jon/ops, or DotNetPert once granted
   access below.
2. **Fix today (before stripe testing):** DotNetPert repairs the DB
   connectivity (triage hypothesis: creds/SSL/endpoint drift after DB
   changes — §5). Needs from Jon:
   - container access on jondeb (`docker inspect vsql-vault`, full
     `docker logs`, config `/etc/vsql-vault/vsql-vault.toml`, exec for
     diagnostics);
   - the Rust `vsql-vault` source (not on this machine — Jon to provide the
     repo/path).
3. **Restore and verify:** container back up, pool healthy, `:8420` accepting
   connections from the payment consumer (`PayEz.Payment.Api` →
   `VaultClient`) before stripe testing begins.

**Updated acceptance criteria (supersedes §4.1 for this decision):**

- Zero `PoolTimedOut` from vsql-vault over a 24 h window post-fix — or the
  loop removed/downed by design with the vault lane verified working.
- vsql-vault healthy on dev **before stripe testing starts today**; `:8420`
  reachable from the payment consumer.
- §4.2 and §4.3 unchanged (no new query-lane 500s; no prod promotion until
  resolved).

---

---

## 7. Resolution (DotNetPert, 2026-07-27) — FIXED on dev, in 24h soak

Root cause was config drift, three layers deep — no code change required:

1. **Wrong port.** `vsql-vault.toml` pointed at `127.0.0.1:5433`; Postgres
   (docker `postgres`) publishes `5432`. Nothing on 5433 → sqlx retried
   connects for the 30s acquire timeout → `main` returned `Err` →
   `Error: PoolTimedOut` → exit → docker `unless-stopped` restart = the
   ~34.7s loop. (Boot-time crash loop, never a leak.)
2. **Wrong user, no password.** Toml URL used `postgres` with no password
   (28P01 once the port was fixed). Reset the existing `vsql_vault` role's
   password (server-side, never printed) and pointed the URL at
   `vsql_vault@127.0.0.1:5432/vault`.
3. **Migrator schema split.** Boot then failed `42P07 vault_entries already
   exists`: as user `vsql_vault`, the sqlx migrator's tracking table resolves
   to `vsql_vault._sqlx_migrations` (empty) while the real history (3 applied
   rows) lived in `public._sqlx_migrations` from earlier runs. Seeded
   `vsql_vault._sqlx_migrations` from public. Runtime queries are
   schema-qualified, so search_path only affected the migrator.
4. **API-key drift (found in verification).** Container env
   `VSQL_VAULT_API_KEY` ≠ paymentapi_rosa's `VsqlVault:ApiKey` — would have
   401'd every payment call. Recreated the container (identical
   image/mounts/netmode=host/restart/gelf-graylog logging) with the key
   payment expects.

**Verification (2026-07-27 15:19–15:26Z):** clean boot ("connected to
PostgreSQL", "migrations applied", "listening 0.0.0.0:8420"); `/health` and
`/health/ready` green from host and LAN; authenticated list call with the
payment key → 200 `{"entries":[],"total":0}` (the exact stripe-testing
lane); zero `PoolTimedOut` since 15:08:53Z (last pre-fix occurrence);
container stable. Toml backup: `/home/dotnetpert/vsql-vault/vsql-vault.toml.bak-20260727`.

**Non-blocking notes:** the toml holds the DB password in plaintext on the
host (pre-existing pattern; `VSQL_VAULT_DB_URL` env would avoid it). The
Rust source Jon provided (`E:\Repos\vibe\vibesql-vault`) matches the
deployed migration set 1:1.

**24h soak:** zero-PoolTimedOut window runs to 2026-07-28 ~15:20Z; DotNetPert
confirms then, per the updated criterion.

---

| Role | Agent | Status |
|---|---|---|
| Decision | Jon | ✅ 2026-07-27 — keep on dev (stripe testing today); stop now + fix today |
| Stop container | Jon/ops or DotNetPert (with access) | ✅ 2026-07-27 |
| Access + Rust source | Jon | ✅ 2026-07-27 — ssh key (dotnetpert@jondeb, docker group) + `E:\Repos\vibe\vibesql-vault` |
| DB connectivity fix | DotNetPert | ✅ 2026-07-27 — see §7 |
| Verify restored lane | DotNetPert / QAPert | ✅ DotNetPert 15:26Z (health/ready/authed payment-key call); 24h soak confirmation due 2026-07-28 ~15:20Z |

---

## 8. Close-out — soak compressed (BAPert, 2026-07-27 ~16:15Z)

Jon directed closing the soak early. Justification: the failure mode was a
boot crash-restart loop with a rock-steady ~34.7 s cadence (a week of
Graylog history); if the fix were wrong, the loop would have resumed within
~35 s of restart. Directly verified on jondeb at ~16:15Z, ~1 h post-restore:

- Container `Up About an hour`, **restart count 0** since recreation at
  15:25:18Z (the loop previously restarted every ~35 s → ~100+ cadence
  periods suppressed).
- **Zero `PoolTimedOut`** in container logs since 15:08:53Z (last pre-fix
  occurrence).
- `/health/ready` from LAN: `{"status":"ready","pg":"ok"}` — the drifted DB
  layer itself confirmed connected; `/health` ok.
- Authenticated payment-lane 200 already verified by DotNetPert 15:26Z (§7).

Acceptance criteria: (1) zero PoolTimedOut — met per compressed window with
Jon accepting the residual risk as risk owner; (2) no new query-lane 500s —
held; (3) no-prod-promotion note stands and is satisfied for dev purposes.
Stripe lane open for today's testing. **WO closed.**
