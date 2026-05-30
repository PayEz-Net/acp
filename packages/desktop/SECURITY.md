# SECURITY.md (DRAFT — for OSS launch)

**Status:** Draft by BAPert 2026-05-20 during pre-publish secrets sweep (task #9).
**Owner for final form:** Jon or Aurum at publish-prep.
**Purpose:** ship as `SECURITY.md` in the OSS repo root when ACP goes public.

---

# Security

ACP is published as open source. This document covers the security posture, how to report issues, and the audit history.

## Reporting Security Issues

Please report security vulnerabilities to **security@payez.com** rather than opening a public issue. Reports are read promptly and we'll respond within 48 hours.

For non-critical hardening suggestions, GitHub issues with the `security` label are fine.

## Threat Model

ACP is a desktop application bundled via Electron. Some practical notes:

- **Code is extractable.** The published `.exe` ships as an Electron app. Anyone can extract the source via `npx asar extract`. There are no secrets hidden in the binary that aren't also visible in this repo. We treat the npm publish event as the disclosure event for everything in the artifact.
- **OAuth client IDs are public.** ACP includes a baked OAuth client identifier (`BAKED_VIBE_CLIENT_ID` in `src/main/api-server.ts`) to satisfy the backend's required-config check. Per OAuth norms, client IDs are non-secret — they're equivalent to a username. The corresponding client secret is never baked or shipped.
- **Local secrets are per-session.** ACP generates a per-launch random secret (`ACP_LOCAL_SECRET`, 32 random bytes) for the Electron main → local backend authentication. This secret never leaves the running process and is regenerated every launch.
- **Cloud credentials come from environment.** ACP expects users to supply their own cloud credentials via `.env` at runtime. We ship a `.env.example` template; we do not ship working credentials.

## Audit History

### May 2026 — Pre-publish audit (BAPert + Aurum)

Pre-publish audit identified hardcoded development credentials in two user-facing template documents under `colonize-templates/.claude/commands/`. The credentials were:

1. A VIBE-API client secret (development environment) in `agent-docs.md`.
2. A development VibeSQL container auth secret in `vibe-sql.md`.

Both were stripped before any public release. Neither credential was distributed beyond the development environment prior to remediation. The first was retired as part of the broader VIBE auth dependency removal completed in the same pre-publish window; the second is a development-only credential against an internal network endpoint that is not publicly routable.

Audit commits:
- `c23b4a8` — colonize-templates: strip leaked VIBE client secret from agent-docs.md
- `ef1551c` — colonize-templates: strip dev-box references from vibe-sql.md

A broader sweep verified no other categories of secret exposure: no third-party API keys (Anthropic, OpenAI, AWS, GitHub, Slack), no PEM/private keys, no DB connection strings, no HMAC/signing keys outside of explicit environment-variable references.

## Internal vs External Templates

Two parallel template directories exist in the source tree:

- `.agents/commands/` — internal development templates, used by the project's own contributors. May contain references to internal infrastructure.
- `colonize-templates/.claude/commands/` — user-facing templates shipped via `extraResources` to every installer. Held to OSS-grade standards: no internal infrastructure references, no development credentials, all sensitive values represented as `$ENV_VAR` placeholders.

Contributors modifying templates: changes to `colonize-templates/` must use env-var placeholders; do not paste real credentials. Changes to `.agents/` may include internal references but should still avoid checked-in secrets.

## Reproducible Builds

[TODO: fill in once build process is documented for OSS contributors. electron-builder + auto-updater pipeline + Azure Blob publish target.]

## Code Signing

[TODO: fill in once Windows code signing lands (separate WO, deferred per Jon). Auto-updates verify signature; unsigned builds are non-distributable.]

## Acknowledgments

[TODO: fill in once contributors / reporters surface.]

---
*This document tracks ACP's security posture from npm publish (May 2026) forward. For earlier history, see the git log.*
