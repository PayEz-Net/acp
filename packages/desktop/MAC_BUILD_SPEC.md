# ACP Desktop — macOS Build Spec & Bring-Up Guide

**Scope:** Build and run ACP Desktop from source on macOS, then cut a signed `.dmg` + `.zip` release.  
**Status:** Ready for first bring-up. One cross-platform fix already applied (`api-server.ts` orphan-kill).

---

## 1. Prerequisites

| Requirement | Command to verify | Notes |
|-------------|-------------------|-------|
| macOS 13+ (Ventura or later) | `sw_vers` | Older versions may work but are untested. |
| Xcode Command Line Tools | `xcode-select -p` | `xcode-select --install` if missing. Required for `node-gyp` / native compiles. |
| Node.js 20 LTS | `node -v` | Use `nvm` or the official pkg. Must match the Windows dev box (v20.18.2). |
| npm 10+ | `npm -v` | Ships with Node 20. |
| Git | `git -v` | For cloning repos. |

Optional but recommended:

```bash
# Homebrew (for easy CLI tool installs)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

---

## 2. Repository Layout

ACP is two sibling repos. The desktop app **expects** `acp-api` to live next to it in dev mode.

```
~/Repos/
├── acp-desktop/     # this repo
└── acp-api/         # backend API (sibling)
```

Clone them:

```bash
cd ~/Repos
git clone <acp-desktop-url>
git clone <acp-api-url>
```

(Ask Jon/Aurum for the exact remotes if you don't have them — they are Azure DevOps repos.)

---

## 3. Backend Setup (`acp-api`)

The API must be runnable before the desktop shell can start.

```bash
cd ~/Repos/acp-api
npm install
```

**No build step is required for dev mode** — `acp-desktop` launches it via `tsx` in development.  
For packaged builds, `prepare-acp-api.cjs` handles the compile automatically.

Quick sanity check:

```bash
node api/server.js
# Should start on localhost:3001
# Ctrl+C after you see "Server running"
```

---

## 4. Desktop Setup (`acp-desktop`)

### 4.1 Install dependencies

```bash
cd ~/Repos/acp-desktop
npm install
```

### 4.2 Rebuild native modules for Electron

`node-pty` (the PTY library that spawns Claude Code sessions) has platform-specific native bindings.  
It **must** be rebuilt against the exact Electron version declared in `package.json` (currently v28).

```bash
npx electron-rebuild
```

> **If `electron-rebuild` fails:** Make sure Xcode CLI tools are installed (`xcode-select --install`).  
> `node-pty` uses `node-gyp` which needs the system compiler toolchain.

Verify the rebuild succeeded:

```bash
ls node_modules/node-pty/build/Release/
# You should see `pty.node` (macOS binary)
```

Other native deps (`sharp`, etc.) will also be rebuilt by the same command.

---

## 5. Dev Workflow (run from source)

```bash
cd ~/Repos/acp-desktop
npm run dev:electron
```

What happens:
1. Vite dev server starts on `localhost:40020`
2. TypeScript main-process code compiles
3. Electron launches
4. The API sidecar auto-starts from your sibling `acp-api` folder
5. You see the ACP login / picker window

**Hot-reload:** Renderer (React) code hot-reloads via Vite. Main-process changes require a restart (`Ctrl+C` and re-run).

---

## 6. Build Workflow (`npm run dist:mac`)

```bash
cd ~/Repos/acp-desktop
npm run dist:mac
```

This executes:
1. `prepare-acp-api.cjs` — copies `../acp-api`, builds it, prunes dev deps
2. `npm run build:electron` — compiles renderer + main TypeScript
3. `electron-builder --mac` — produces:
   - `release/ACP-0.1.0.dmg` — drag-and-drop installer
   - `release/ACP-0.1.0-mac.zip` — portable zip
   - `release/mac/ACP.app` — unpacked `.app` bundle

### 6.1 Code Signing & Notarization (configured, env-driven)

The repo is already set up for signing + notarization. You only need to provide credentials.

**Prerequisites:**
- Apple Developer account ($99/yr)
- **Developer ID Application** certificate in your Mac Keychain (download from Apple Developer portal)
- App-Specific Password (generate at [appleid.apple.com](https://appleid.apple.com/account/manage))
- 10-character **Team ID** (found in Apple Developer account → Membership)

**Configure:**

```bash
cd ~/Repos/acp-desktop
cp .env.example .env
# Edit .env and fill in:
#   APPLE_ID=dev@payez.net
#   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
#   APPLE_TEAM_ID=ABCD123456
```

**Build with signing + notarization:**

```bash
export $(cat .env | xargs)
npm run dist:mac
```

What happens:
1. `electron-builder` signs the `.app` using the **Developer ID Application** certificate from your Keychain
2. `build/afterSign.js` uploads the signed `.app` to Apple Notary Service (`notarytool`)
3. Notarization completes (usually 1–5 minutes)
4. `electron-builder` staples the ticket and builds the `.dmg`

> **Without env vars:** The build still works — `afterSign.js` detects missing credentials, skips notarization with a warning, and produces an unsigned `.dmg`. Gatekeeper will warn on first open.

> **Hardened Runtime & Entitlements:** The app uses `build/entitlements.mac.plist` which grants the permissions required for `node-pty` (JIT, unsigned executable memory, dyld env vars, library validation disable, and Apple Events for process spawning).

---

## 7. Platform-Specific Behavior Differences

| Feature | Windows | macOS |
|---------|---------|-------|
| Shell | `powershell.exe` | `bash` (Zsh users: change in `pty.ts` if desired) |
| Agent spawn | Auto-injects `"report as AgentName"` | Same — injected via PTY write |
| API orphan kill | `taskkill` | `lsof` + `SIGKILL` *(already fixed)* |
| Installer | NSIS `.exe` (consent + folder picker) | `.dmg` drag-to-Applications |
| Portable | `.exe` | `.zip` |
| App data | `%APPDATA%\ACP` | `~/Library/Application Support/ACP` |
| Settings store | `electron-store` (cross-platform) | Same |

### 7.1 One macOS quirk — `bash` vs `zsh`

macOS 10.15+ defaults to `zsh`. `pty.ts` currently falls back to `bash` on non-Windows:

```ts
const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
```

If `bash` is missing on your Mac (Apple removed it from some clean installs):

```bash
# Option A: install bash
brew install bash

# Option B: change pty.ts to use zsh (local edit, don't commit)
const shell = process.platform === 'win32' ? 'powershell.exe' : 'zsh';
```

Claude Code works fine in either shell.

---

## 8. Known Issues & Checklist

| # | Issue | Status | Owner |
|---|-------|--------|-------|
| 1 | `api-server.ts` orphan-kill used Windows-only CLI | **Fixed** | NextPert |
| 2 | `node-pty` native rebuild required on first setup | Documented | You |
| 3 | Apple code-signing configured (env-driven) | **Ready** — needs Apple ID + Team ID in `.env` | Jon/Aurum |
| 4 | No macOS-specific installer handoff (colonization consent) | `.dmg` doesn't need NSIS gate | N/A |
| 5 | `windowsHide: true` in spawn opts | Silently ignored on macOS — safe | N/A |
| 6 | `build/installer.nsh` is Windows-only | Not used for mac builds | N/A |

---

## 9. First-Time Bring-Up Checklist

- [ ] macOS 13+ with Xcode CLI tools
- [ ] Node 20 + npm 10
- [ ] `acp-desktop` and `acp-api` cloned as siblings
- [ ] `cd acp-api && npm install`
- [ ] `cd acp-desktop && npm install`
- [ ] `npx electron-rebuild` (verify `pty.node` exists)
- [ ] `npm run dev:electron` → app launches
- [ ] Log in / consent / pick workspace
- [ ] Start a project → 4 agents spawn in grid
- [ ] `npm run dist:mac` → `.dmg` and `.zip` produced in `release/`

---

## 10. Next Steps (post bring-up)

1. **QA Gate** — Run the same gates as Windows:
   - `npx tsc --noEmit` (clean)
   - `npx vitest run colonize` (pass)
   - Clean install test: mount `.dmg`, drag to Applications, launch, consent, workspace, Start, confirm 4 agents

2. **Code-signing** — If distributing outside the team, add Apple Developer ID + notarization to `package.json`

3. **Publish** — Upload `.dmg` to GitHub Releases or npm (pattern TBD), reference from `idealvibe.online`

---

*Spec version: 1.0 — 2026-05-19*  
*Written by: NextPert / BAPert pipeline*
