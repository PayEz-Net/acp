import Store from 'electron-store';
import { randomBytes } from 'crypto';
import { AppSettings, DEFAULT_SETTINGS } from '../shared/types';

// Settings store (unencrypted - no sensitive data)
export const store = new Store<AppSettings>({
  name: 'settings',
  defaults: DEFAULT_SETTINGS,
});

// Generate or retrieve encryption key (stored separately, unencrypted)
const keyStore = new Store<{ encryptionKey: string }>({ name: 'keychain' });

function getOrCreateEncryptionKey(): string {
  let key = keyStore.get('encryptionKey');
  if (!key) {
    key = randomBytes(32).toString('hex');
    keyStore.set('encryptionKey', key);
    console.log('[Store] Generated new encryption key');
  }
  return key;
}

// Auth store (encrypted - contains tokens)
interface AuthData {
  session: string | null; // JSON stringified session
}

const authStore = new Store<AuthData>({
  name: 'auth',
  encryptionKey: getOrCreateEncryptionKey(),
  defaults: {
    session: null,
  },
});

// Auth session functions
export function getAuthSession(): string | null {
  return authStore.get('session');
}

export function setAuthSession(sessionJson: string | null): void {
  authStore.set('session', sessionJson);
}

export function clearAuthSession(): void {
  authStore.delete('session');
}

export function getSettings(): AppSettings {
  const storedVersion = (store.get('settingsVersion' as keyof AppSettings) as number | undefined) ?? 0;
  const currentVersion = DEFAULT_SETTINGS.settingsVersion ?? 0;

  // Migrate when code defaults are newer than stored settings.
  // Bump settingsVersion in DEFAULT_SETTINGS whenever you change defaults
  // that should propagate to existing installs.
  if (storedVersion < currentVersion) {
    console.log(`[Store] Migrating settings from v${storedVersion} to v${currentVersion}`);
    store.set('agentProvider' as keyof AppSettings, DEFAULT_SETTINGS.agentProvider);

    const storedAgents = store.get('agents') ?? [];
    const migratedAgents = storedAgents.map(agent => {
      const defaultAgent = DEFAULT_SETTINGS.agents.find(d => d.name === agent.name);
      return { ...agent, provider: defaultAgent?.provider ?? agent.provider ?? 'kimi' };
    });
    store.set('agents' as keyof AppSettings, migratedAgents);

    // v3→v4 migration — spec §4.4 / §5.1, AC-A6 enforces.
    // Drop any cloud-authoritative keys that may have leaked into
    // electron-store from old installs or hand-edits. The pointer to
    // the active project is owned by cloud DB (per Decision 0); local
    // copies are render caches at best and become wrong-team-after-restart
    // bugs at worst. UI prefs (position/color/workDir/provider/autoStart)
    // are NOT touched — `agentReconcile` does the agent-array migration
    // on first cloud sync.
    if (storedVersion < 4) {
      const droppable = ['activeProjectId', 'vibeClientId'] as const;
      for (const key of droppable) {
        if ((store as unknown as { has: (k: string) => boolean }).has(key)) {
          (store as unknown as { delete: (k: string) => void }).delete(key);
          console.log(`[Store] v3→v4 migration dropped ${key} from electron-store`);
        }
      }
    }

    // v4→v5 migration — per-agent autoStart is vestigial (no editor exists).
    // New agents added after the initial team were defaulting to false and
    // never auto-starting. Flip all stored agents to true so the full team
    // spawns together. (Aurum bug — DotNetPert handoff 2026-05-23.)
    if (storedVersion < 5) {
      const storedAgents = store.get('agents') ?? [];
      const migratedAgents = storedAgents.map((agent: any) => ({
        ...agent,
        autoStart: true,
      }));
      store.set('agents' as keyof AppSettings, migratedAgents);
      console.log(`[Store] v4→v5 migration set autoStart=true for ${migratedAgents.length} agent(s)`);
    }

    // v5→v6 migration — global Claude effort default flips 'max' → 'high'
    // (Aurum 1355 / doc-6 reverse #3). 'max' was the silent-expensive default
    // burning tokens on every spawn. Flip only persisted 'max' → 'high'; leave
    // deliberate 'low'/'medium'/'high' choices untouched. 'max' stays selectable.
    if (storedVersion < 6) {
      const storedEffort = store.get('claudeEffort' as keyof AppSettings) as
        | AppSettings['claudeEffort']
        | undefined;
      if (storedEffort === 'max') {
        store.set('claudeEffort' as keyof AppSettings, 'high');
        console.log(`[Store] v5→v6 migration flipped claudeEffort 'max' → 'high'`);
      }
    }

    // v6→v7 migration — image paste in terminal composer. Existing installs
    // should opt-in by default; instant-send stays off unless explicitly enabled.
    if (storedVersion < 7) {
      const storedEnable = store.get('enableTerminalImagePaste' as keyof AppSettings) as boolean | undefined;
      if (storedEnable === undefined) {
        store.set('enableTerminalImagePaste' as keyof AppSettings, DEFAULT_SETTINGS.enableTerminalImagePaste);
        console.log('[Store] v6→v7 migration set enableTerminalImagePaste=true');
      }
      const storedInstant = store.get('instantSendPastedImages' as keyof AppSettings) as boolean | undefined;
      if (storedInstant === undefined) {
        store.set('instantSendPastedImages' as keyof AppSettings, DEFAULT_SETTINGS.instantSendPastedImages);
        console.log('[Store] v6→v7 migration set instantSendPastedImages=false');
      }
    }

    store.set('settingsVersion' as keyof AppSettings, currentVersion);
  }

  // Backfill per-agent provider from defaults ONLY when the stored agent
  // is missing the field entirely (not to override user choices).
  const storedAgents = store.get('agents') ?? [];
  const agents = storedAgents.map(agent => {
    if (!agent.provider) {
      const defaultAgent = DEFAULT_SETTINGS.agents.find(d => d.name === agent.name);
      if (defaultAgent?.provider) {
        return { ...agent, provider: defaultAgent.provider };
      }
    }
    return agent;
  });

  return {
    layout: store.get('layout'),
    focusAgent: store.get('focusAgent'),
    agents,
    mailPollInterval: store.get('mailPollInterval'),
    theme: store.get('theme'),
    windowBounds: store.get('windowBounds'),
    sidebarWidth: store.get('sidebarWidth'),
    showSidebar: store.get('showSidebar'),
    environment: store.get('environment') ?? 'prod',
    vibeClientId: store.get('vibeClientId' as keyof AppSettings) as string ?? '',
    agentProvider: (store.get('agentProvider' as keyof AppSettings) as AppSettings['agentProvider']) ?? 'kimi',
    claudeEffort: (store.get('claudeEffort' as keyof AppSettings) as AppSettings['claudeEffort']) ?? 'high',
    settingsVersion: (store.get('settingsVersion' as keyof AppSettings) as number) ?? currentVersion,
    // Installer-handoff fields. setSettings persists these (Object.entries
    // → store.set), but getSettings() rebuilds an explicit object and was
    // OMITTING them — so getSettings().installerWorkspaceRoot /
    // .colonizationConsent were always undefined, which made the
    // spawn-orchestrator bail "NO workspace root" and gated colonize off.
    installerWorkspaceRoot: store.get('installerWorkspaceRoot' as keyof AppSettings) as string | undefined,
    colonizationConsent: (store.get('colonizationConsent' as keyof AppSettings) as boolean | undefined)
      ?? DEFAULT_SETTINGS.colonizationConsent ?? false,
    // Same whitelist bug: setSettings persisted hasSeenWelcome but
    // getSettings() never read it back → !hasSeenWelcome always true →
    // the welcome modal reappeared every launch ("never goes away").
    hasSeenWelcome: (store.get('hasSeenWelcome' as keyof AppSettings) as boolean | undefined)
      ?? DEFAULT_SETTINGS.hasSeenWelcome ?? false,
    enableTerminalImagePaste: (store.get('enableTerminalImagePaste' as keyof AppSettings) as boolean | undefined)
      ?? DEFAULT_SETTINGS.enableTerminalImagePaste,
    instantSendPastedImages: (store.get('instantSendPastedImages' as keyof AppSettings) as boolean | undefined)
      ?? DEFAULT_SETTINGS.instantSendPastedImages,
    // ACP session ids for crash-safe resume (WO runtime wait-state visibility).
    // Must be whitelisted here like every other key — setSettings persists it,
    // but a missing getSettings line would silently drop it on read-back
    // (same bug class as installerWorkspaceRoot/hasSeenWelcome above).
    acpSessionIds: store.get('acpSessionIds' as keyof AppSettings) as Record<string, string> | undefined,
  };
}

export function setSettings(settings: Partial<AppSettings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    if (value === undefined) {
      (store as unknown as { delete: (k: string) => void }).delete(key);
    } else {
      store.set(key as keyof AppSettings, value);
    }
  });
}

// ─── next-boot overlay (Wave C/2 Commit D/A) ──────────────────────────
// Per Aurum R1 lock (BAPert msg 1156): the project-switch flow writes a
// `nextBootOverlay` flag right before app.quit() so that on the cold
// boot the renderer can synchronously read it during the pre-mount
// HTML stage and paint a "Switching to <project_name>…" overlay before
// React mounts. Zero-flash UX — user sees one continuous surface from
// click through restart through landing. Cleared by React on
// mount-complete via clearNextBootOverlay().

export interface NextBootOverlay {
  project_id: number;
  project_name: string;
}

const overlayStore = new Store<{ nextBootOverlay: NextBootOverlay | null }>({
  name: 'boot-overlay',
  defaults: { nextBootOverlay: null },
});

export function getNextBootOverlay(): NextBootOverlay | null {
  return overlayStore.get('nextBootOverlay') ?? null;
}

export function setNextBootOverlay(o: NextBootOverlay): void {
  overlayStore.set('nextBootOverlay', o);
}

export function clearNextBootOverlay(): void {
  overlayStore.delete('nextBootOverlay');
}

// ---------------------------------------------------------------------------
// STARTED PROJECT — the dev's declared current project, MACHINE-LOCAL.
//
// THE RULE (Jon, 2026-08-01):
//   The current project is the project the dev clicked START on, ON THIS MACHINE.
//   That is the only evidence. There is no other factor.
//
// This store is the durable source of truth for that declaration. It is written
// on every Start/switch and replayed to the acp-api sidecar on every boot, so a
// restart comes back on the project the dev chose rather than on whatever a
// shared cloud slot happened to say.
//
// WHY NOT THE CLOUD
// `/v1/users/me/current-project` is a SINGLE PER-USER SLOT SHARED ACROSS MACHINES.
// `agentSessionLifecycle.ts` already documents this and refuses to use it. On
// 2026-07-31/08-01 one account driving two projects on two machines produced:
// two agents unreachable by anyone for a full night (every send AGENT_NOT_FOUND),
// a sprint's mail filed into another project, and a cold restart landing on the
// wrong project. The cloud cannot know which project a dev wants to work on.
//
// Keyed by user so one machine shared by two devs cannot serve the wrong
// declaration. No fallback: absent means "no project engaged", which callers
// must surface rather than guess around.

export interface StartedProject {
  project_id: number;
  project_name: string | null;
  user_id: string;
  started_at: string;
}

const startedProjectStore = new Store<{ startedProject: StartedProject | null }>({
  name: 'started-project',
  defaults: { startedProject: null },
});

/** The project this dev declared on this machine, or null if none. */
export function getStartedProject(): StartedProject | null {
  return startedProjectStore.get('startedProject') ?? null;
}

/**
 * Record a Start click. Clicking Start on a different project is the ONLY way
 * this value changes.
 */
export function setStartedProject(entry: StartedProject): void {
  startedProjectStore.set('startedProject', entry);
  console.log(
    `[Store] started project declared: ${entry.project_id}` +
      ` (${entry.project_name ?? 'unnamed'}) user=${entry.user_id}`,
  );
}

/** Clear on sign-out. Not part of normal operation. */
export function clearStartedProject(): void {
  startedProjectStore.delete('startedProject');
}
