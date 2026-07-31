# Switching Model Providers (Claude ↔ Kimi ↔ Codex)

ACP supports three AI agent providers: **Claude**, **Kimi**, and **Codex**.  
This doc explains every place that must change when you switch the default provider.

> **Quick rule:** For a live flip (runtime-only, no redeploy), edit the persisted `settings.json` and restart. For a new-install default, change the code fallback too.

---

## 0. TL;DR — Flip Everyone to Kimi (the common case)

When the whole agent team needs to run on Kimi for the next ACP session:

1. **Close ACP** (close the window; the dev-electron processes may stay — kill `concurrently` PID if needed per this session's restart playbook).
2. **Edit `settings.json`** (path in §1 below). Change the single key:
   ```json
   "agentProvider": "kimi"
   ```
3. **Restart ACP** — `npm run dev:electron` from `E:\Repos\acp-stable` (or launch the packaged app).
4. **Verify** — launcher log should show `[PTY] Provider for <agent>: kimi (global: kimi)` for each agent. Matching `(global: kimi)` means the flip took effect.

To flip back to Claude: change the value to `"claude"` and restart. The value is the only thing the runtime spawn path reads.

> **Note on per-agent `provider` fields in `settings.json`** — today the runtime uses the `agentProvider` *global* value for every spawn; the per-agent `provider` field stored alongside each agent row is carried in the data model but **not consumed by the PTY spawn code** (pty.ts line 204 = "Global-only mode: all agents use the same provider setting"). A future mixed-mode spawn path will honor per-agent overrides; until then, only the global value matters for runtime.

---

## 1. User / Runtime Settings (Overrides Everything)

### Desktop App (`acp-stable` / `acp-desktop`)

The Electron app stores the active provider in `agentProvider` inside its `settings.json`.

**Windows:**
```powershell
$env:APPDATA\agent-collaboration-platform\settings.json
```

**macOS / Linux:**
```bash
~/.config/agent-collaboration-platform/settings.json
```

Change the value:
```json
"agentProvider": "kimi"
```

Valid values: `"claude"`, `"kimi"`, `"codex"`

> You must **restart the app** after editing this file. The change only applies to **new** agent sessions.

---

## 2. Code-Level Defaults (`acp-stable` Desktop Shell)

These files contain fallback defaults used when no persisted setting exists (e.g., first install).

| File | What to change |
|------|----------------|
| `src/main/store.ts` | `agentProvider` fallback (`?? 'claude'` → `?? 'kimi'`) |
| `src/main/pty.ts` | `const provider = settings.agentProvider \|\| 'claude'` → `\|\| 'kimi'` |
| `resources/bin/acp-hook.mjs` | `runtime: event.runtime \|\| 'claude-code'` → `\|\| 'kimi-cli'` |

### PTY Launch Behavior

`src/main/pty.ts` branches on `provider`:

- **Claude:** spawns `claude "report as {agent}" --dangerously-skip-permissions --effort {level} --dangerously-load-development-channels server:acp-mail`
- **Kimi:** spawns `kimi --yolo --model kimi-for-coding-highspeed`, then PTY-injects `report as {agent}` after the banner
- **Codex:** spawns `codex --full-auto --model {model}`, then PTY-injects `report as {agent}`

If you add a new provider, you must add a branch here.

---

## 3. Backend API Defaults (`acp-api`)

| File | What to change |
|------|----------------|
| `api/routes/agents.ts` | `program` and `model` in the agent profile response |
| `api/contractors/sessionManager.ts` | `this.contractorCmd` default (`'claude'` → `'kimi'`) |
| `api/contractors/processMonitor.ts` | `isPidAlive()` Windows tasklist filter (`'claude'` → `'kimi'`) |

### Contractor CLI Args Compatibility

`sessionManager.ts` currently auto-detects the provider and builds the correct arg list:

- **Claude:** `--print --dangerously-skip-permissions --system-prompt <profile> --prompt <task>`
- **Kimi / Others:** `--print --prompt <profile>\n\n<task>`

If you switch providers, verify the target CLI supports the flags being passed.

---

## 4. Environment Variable Overrides

You can override some behavior without touching code:

| Variable | Repo | Effect |
|----------|------|--------|
| `ACP_CONTRACTOR_CMD` | `acp-desktop/acp-api` | Overrides the contractor binary (default: `kimi`) |
| `KIMI_MODEL` | System | Model passed to Kimi CLI |

---

## 5. Checklist: Switching from Claude to Kimi

1. **Persisted settings** (`settings.json`)  
   `"agentProvider": "kimi"`
2. **Desktop fallbacks** (`acp-stable/src/main/store.ts`, `src/main/pty.ts`)  
   Change `|| 'claude'` → `|| 'kimi'`
3. **Hook runtime** (`acp-stable/resources/bin/acp-hook.mjs`)  
   Change `'claude-code'` → `'kimi-cli'`
4. **API profile** (`acp-desktop/acp-api/api/routes/agents.ts`)  
   `program: 'kimi-cli'`, `model: 'moonshotai/kimi-k2.5'`
5. **Contractor defaults** (`acp-desktop/acp-api/api/contractors/sessionManager.ts`)  
   `this.contractorCmd = ... || 'kimi'`
6. **Process monitor** (`acp-desktop/acp-api/api/contractors/processMonitor.ts`)  
   `output.toLowerCase().includes('kimi')`
7. **Restart the desktop app** so new sessions pick up the change.

---

## 6. Verification

After restart, tail the launcher log or watch the console output and look for:

```
[PTY] Provider for NextPert: kimi (global: kimi)
[PTY] Provider for BAPert:   kimi (global: kimi)
[PTY] Provider for DotNetPert: kimi (global: kimi)
[PTY] Provider for QAPert:   kimi (global: kimi)
```

Per-agent line shows the resolved provider for that spawn; `(global: X)` echoes the `agentProvider` value from `settings.json`. If any agent shows a different provider than `(global: X)`, check §7 below.

---

## 7. Per-Agent `provider` Field — Current Reality

The `agents[]` array in `settings.json` has a `provider` field on each row. You will see this field populated with `"claude"` for each of the 4 default agents regardless of what `agentProvider` is set to. That's because:

1. **`getSettings()` in `store.ts` backfills** the per-agent `provider` from `DEFAULT_SETTINGS.agents[].provider` on every read. The hardcoded defaults are `'claude'` for each of BAPert / DotNetPert / NextPert / QAPert.
2. **The PTY spawn path in `pty.ts:204`** uses only the *global* `settings.agentProvider` value, not the per-agent `provider` field. Comment: "Global-only mode."

Net effect today: **only `settings.agentProvider` (the top-level global) matters for runtime.** Per-agent `provider` values in `settings.json` are decorative and will be clobbered back to `'claude'` on the next `getSettings()` call.

### Known bug / fix

The `store.ts` backfill currently *overwrites* a stored per-agent `provider` with the default, even when the stored value is valid and different. The correct behavior is **backfill only when the stored value is missing**:

```typescript
// Current (line 54-60):
if (defaultAgent?.provider) {
  return { ...agent, provider: defaultAgent.provider };
}

// Correct:
if (!agent.provider && defaultAgent?.provider) {
  return { ...agent, provider: defaultAgent.provider };
}
```

Until this is fixed AND the pty.ts spawn is updated to read per-agent overrides, **treat `agentProvider` (global) as the one and only runtime provider knob.**

### Mixed-mode spawn (future)

When mixed-mode spawn lands, the resolution rule will be:

- `settings.agents[n].provider` wins if present and valid
- `settings.agentProvider` is the fallback for agents without an override
- Code-level `DEFAULT_SETTINGS` is the fallback for everything else

Track that work at commit `744265c` (mixed-mode provider support — data model landed; spawn path pending).

---

## 8. Common Pitfalls

> **"I changed the code but it still launches Claude."**

The persisted `settings.json` (step 1) wins over code defaults at runtime. Edit that file or change the setting in-app via Settings → AI Provider, then restart.

> **"I edited a per-agent `provider` field in `settings.json` and nothing changed."**

Per §7 above, the spawn path reads the global `agentProvider` only today. Change the global value, restart, verify via `(global: X)` in the launcher log.

> **"The global is `kimi` but agents launch Claude anyway."**

Check that the ACP process tree actually restarted — `concurrently` + `vite` hot-reload only applies to renderer code; main-process code (pty.ts, store.ts) requires a full kill-and-relaunch. Verify by looking at the launcher-log timestamp for `Server running on 127.0.0.1:3001` — if it's older than your settings edit, restart didn't take.
