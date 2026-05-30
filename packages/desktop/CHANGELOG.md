# Changelog

## [0.1.0] — 2026-05-23

### Added
- **Specialist Library** — Browse, engage, and tailor 60+ specialist agents (security reviewers, performance optimizers, language specialists, accessibility architects, and more). Backend complete; UI scaffold in progress.
- **Agent mail project isolation** — Mail is now scoped to the active project. Cross-project bleed eliminated.
- **VIBE_CLIENT_ID removal** — Retired legacy HMAC auth from renderer. All cloud calls now use Bearer tokens. P0 OSS blocker cleared.
- **Help & documentation** — README, FAQ, Privacy Policy, Terms of Service, Security Guide, and in-app help content shipped.
- **Contributing guide** — Community contribution standards, code style, and PR process documented.

### Changed
- **Startup-config reads docstore** — `GET /v1/agents/startup-config` now correctly reads from `vibe.documents` (client_id=0) instead of the retired real-table. Unlocks Specialist Library catalog.
- **Type-aware seeding as canonical** — Project team seeding uses type-aware model (BA+QA always-on, tech specialists stack-gated) rather than rigid `is_canonical` whitelist.

### Security
- Internal preview warning added to README and FAQ
- SECURITY.md shipped with threat model, audit history, and reporting process
- Cross-tenant guard verification in progress (QAPert 2-team isolation test)

### Known Issues
- **Project switching requires restart** — Hot-switching is scheduled for Wave C
- **Settings read-only in app** — Edit settings on idealvibe.online; ACP syncs within 60s
- **Prod specialist seed pending execution** — 60 specialists delivered, awaiting Jon/ops to run seed script against prod VibeSQL

---

## [0.1.1] — Upcoming

### Planned
- **Auto-update** — electron-updater + GitHub Releases integration
- **Specialist Library UI** — TeamBuilderModal, AgentCatalogCard, TeamRosterList components
- **Installer polish** — NSIS Windows installer with first-run welcome
