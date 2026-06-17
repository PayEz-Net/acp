# ACP — Agent Collaboration Platform

> *Ship faster with a team of AI agents that actually coordinate.*

**ACP** is an open-source desktop application that turns your development environment into a mission control for AI agents. Spawn specialists, review their work, and let them coordinate via agent mail — all from a single surface.

This is **ACP open-source Pro** — the full open-source runtime, wired to the IdealVibe system (IDP auth + VibeSQL) so you can start building immediately, with no backend to set up. *(A fully generic, bring-your-own-backend edition is on the roadmap — not this release.)*

---

## What is ACP?

ACP gives you:

- **A terminal that talks back** — spawn agents, run tasks, review output in real time
- **A mail bus between agents** — your agents coordinate without you babysitting every step
- **A project launcher** — pick a repo, pick a team, start shipping
- **A specialist library** — browse, engage, and tailor domain experts (security reviewers, performance optimizers, accessibility architects) to your project

The entire app is open source. This Pro edition points it at the IdealVibe IDP + Vibe API so you don't have to wire auth yourself.

---

## Quick Start

### Install

```bash
npm install -g acp
acp
```

Or download the latest installer from [GitHub Releases](https://github.com/PayEz-Net/acp/releases).

### First Run

1. Launch ACP
2. Sign in with magic-link or OAuth (Google)
3. Pick or create a project
4. Your team auto-assembles — start vibing

---

## Why Open Source?

We ship the full frontend in the open because:

1. **You should see what you're running** — no black boxes near your code
2. **Self-hosters welcome** — want to run your own backend? Fork `main` and go wild
3. **Contributors eat free** — land a solid PR and we hook you up with Pro access on us

---

## Trust & Privacy

**PayEz** has been building reliable financial infrastructure since before "AI" was every VC's favorite word. We build the boring, reliable stuff that doesn't break when you actually need it.

- **Your data isn't our side hustle** — we don't sell it, we don't train on it, we don't peek. It's yours.
- **We ship, we fix, we don't dip** — no rug pulls, no sudden pivots to blockchain. We maintain what we build.
- **Battle-tested** — same infrastructure that handles real payments. Not a hackathon project.

---

## Security Notice (v1 Internal Preview)

ACP v1 ships as an **internal developer preview**. It runs Claude CLI with elevated permissions and grants agents full access to your user account and repositories. 

- **Do not install on shared or untrusted hardware.**
- Review the [Security Guide](SECURITY.md) for hardening recommendations.
- Report vulnerabilities to security@payez.com.

---

## Getting Help

- **FAQ & Troubleshooting:** See [FAQ.md](FAQ.md)
- **In-app Help:** Click the avatar menu → Help
- **Support:** support@idealvibe.online
- **Issues:** [GitHub Issues](https://github.com/idealvibe/acp/issues)

---

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

MIT — see [LICENSE](LICENSE) for details.

testing 123
