import Store from 'electron-store';
import { AppSettings, DEFAULT_SETTINGS } from '../shared/types';

export const store = new Store<AppSettings>({
  defaults: DEFAULT_SETTINGS,
});

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
  };
}

export function setSettings(settings: Partial<AppSettings>): void {
  Object.entries(settings).forEach(([key, value]) => {
    store.set(key as keyof AppSettings, value);
  });
}
