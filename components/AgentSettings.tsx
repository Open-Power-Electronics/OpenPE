'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { api } from '@/lib/bridge';
import {
  agentSettingsKey,
  defaultAgentSettings,
  validateAgentSettings,
  type AgentSettings,
} from '@/lib/agent-settings';

// Shared presentation preferences, independent of mounted projects and recovery.
const initial = { settings: defaultAgentSettings, ready: false, error: '' };
let state = initial;
let loading: Promise<void> | undefined;
let saves = Promise.resolve();
let revision = 0;
const listeners = new Set<() => void>();
function publish(next: typeof state) {
  state = next;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function load() {
  loading ??= (async () => {
    try {
      const saved = window.openpe ? null : localStorage.getItem(agentSettingsKey);
      const raw = window.openpe
        ? await (await api('agent-settings')).json()
        : saved === null
          ? defaultAgentSettings
          : JSON.parse(saved);
      publish({ settings: validateAgentSettings(raw), ready: true, error: '' });
    } catch {
      publish({
        ...state,
        ready: true,
        error: 'Could not load Agent settings. Queue is active for this session.',
      });
    }
  })();
  return loading;
}
function update(value: AgentSettings) {
  const next = validateAgentSettings(value);
  const current = ++revision;
  publish({ ...state, settings: next });
  saves = saves.then(async () => {
    try {
      if (window.openpe)
        await api('agent-settings', { method: 'POST', body: JSON.stringify(next) });
      else localStorage.setItem(agentSettingsKey, JSON.stringify(next));
      if (current === revision) publish({ ...state, error: '' });
    } catch {
      if (current === revision)
        publish({
          ...state,
          error: 'Agent settings changed for this session, but could not be saved. Try again.',
        });
    }
  });
}
export function useAgentSettings() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => initial,
  );
  useEffect(() => {
    void load();
  }, []);
  return { ...snapshot, update };
}
