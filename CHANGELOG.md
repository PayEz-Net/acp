# Changelog

## [1.0.1] — 2026-06-17

### Fixed
- **Paste truncation** — long multi-line pastes (e.g. a 60+ line DDL block) clipped mid-content. The prior writer chunked every paste into 1024-byte writes, which fragmented the bracketed-paste sequence across writes; the agent TUI finalized on the first fragment and dropped the rest. Raised the single-write threshold (1024 → 16384) so normal pastes go in one intact write; only pastes over 16 KB chunk now.

## [1.0.0] — 2026-06-16

First public release.

### Added
- **Auto-update via GitHub Releases** — `electron-updater` wired to the public `PayEz-Net/acp` release feed. Installed builds check for and pull new versions automatically.
- **Windows installer** — NSIS installer (`ACP Setup 1.0.0.exe`) with directory selection and first-run welcome. Published as a versioned GitHub Release asset.
- **npm install path** — `npm i acp-desktop` thin wrapper fetches the matching installer from GitHub Releases on postinstall, then `acp-desktop` launches it.

### Changed
- **Release home is public** — installable on npm, binaries hosted on GitHub Releases (`PayEz-Net/acp`). Retired the internal Azure DevOps coupling that previously blocked the npm postinstall download. (Public source mirror to follow.)

---

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

## Upcoming

### Planned
- **Specialist Library UI** — TeamBuilderModal, AgentCatalogCard, TeamRosterList components
