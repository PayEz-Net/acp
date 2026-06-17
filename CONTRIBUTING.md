# Contributing to ACP

Thanks for considering a contribution. ACP is an open-source agent collaboration platform, and we welcome help from the community.

---

## Quick Start

1. **Fork** the repository
2. **Clone** your fork
3. **Install dependencies:** `npm install`
4. **Run in dev mode:** `npm run dev`
5. **Make your changes** with clear commit messages
6. **Open a PR** against the `main` branch

---

## Development Setup

### Prerequisites
- Node.js 20+
- npm 10+
- Windows 10/11 (primary target) or macOS/Linux (community-supported)

### Environment
Copy `.env.example` to `.env` and fill in your values. This is the open-source **Pro** edition — it's wired to the IdealVibe system (IDP auth + VibeSQL), so you point it at your IdealVibe credentials and start building. (A fully generic, bring-your-own-backend edition is on the roadmap — not this release.)

### Build
```bash
npm run build:electron    # Production build
npm run dist:win          # Windows installer
```

---

## Where to Contribute

### Good First Issues
Look for issues labeled `good first issue` or `help wanted`. These are vetted by the core team and have clear acceptance criteria.

### Specialist Library
The Specialist Library (build-a-agent) is actively under development. If you have domain expertise in a specific area (security, accessibility, ML, etc.), consider contributing a specialist template to `everything-claude-code/skills/`.

### Bug Fixes
Check the [issue tracker](https://github.com/PayEz-Net/acp/issues) for confirmed bugs. Reproducible bugs with clear steps get priority.

### Documentation
Docs improvements are always welcome. The `docs/` folder and README files are fair game.

---

## Code Style

- **TypeScript:** Strict mode enabled. No `any` without justification.
- **React:** Functional components with hooks. No class components.
- **Electron main process:** Keep IPC surface minimal. Security-sensitive operations stay in the main process.
- **CSS:** Tailwind v3. Custom classes in `src/renderer/styles/`.

### Linting
```bash
npm run lint
npm run lint:fix
```

---

## Testing

### Unit Tests
```bash
npm test
```

### E2E Tests
```bash
npm run test:e2e
```

E2E tests run against a live backend. Do not run them against production.

---

## Commit Messages

Use conventional commits:

```
feat: add search filter to Specialist Library
fix: prevent duplicate PTY spawn on project switch
docs: update FAQ with restart workaround
refactor: extract sendToRenderer helper
test: add AC-20 one-door invariant test
```

---

## Pull Request Process

1. **Branch from `main`** — feature branches only
2. **One concern per PR** — don't bundle unrelated changes
3. **Include tests** — bug fixes need regression tests; features need AC tests
4. **Update docs** — if your change affects user-facing behavior, update README/FAQ/HELP
5. **Pass CI** — green checkmarks required before review
6. **Request review** — @ mention BAPert for spec changes, NextPert for FE, DotNetPert for BE, QAPert for test plans

---

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Never open a public issue for a security bug.

---

## Code of Conduct

- Be respectful. Disagreement is fine; hostility is not.
- Assume good intent.
- Help others learn.

Violations may result in temporary or permanent ban from the project.

---

## Questions?

- **Dev questions:** Open a GitHub Discussion
- **Bug reports:** [GitHub Issues](https://github.com/PayEz-Net/acp/issues)
- **Security:** security@payez.com
- **General:** support@idealvibe.online
