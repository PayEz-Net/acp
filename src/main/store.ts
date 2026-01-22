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
  return {
    layout: store.get('layout'),
    focusAgent: store.get('focusAgent'),
    agents: store.get('agents'),
    mailPollInterval: store.get('mailPollInterval'),
    theme: store.get('theme'),
    windowBounds: store.get('windowBounds'),
    sidebarWidth: store.get('sidebarWidth'),
    showSidebar: store.get('showSidebar'),
    mailPushEnabled: store.get('mailPushEnabled'),
    mailPushUrl: store.get('mailPushUrl'),
  };
}

export function setSettings(settings: Partial<AppSettings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    store.set(key as keyof AppSettings, value);
  });
}
