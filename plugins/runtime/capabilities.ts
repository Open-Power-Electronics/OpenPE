import type { CapabilityDefinition, CapabilityHost } from '../../api/capabilities';
import type { PluginManifest } from '../../api/plugins';

/** Bind declared contributions to the existing validated project capability host. */
export function createPluginScope(
  host: CapabilityHost,
  manifest: PluginManifest,
  lifecycle: {
    available: () => boolean | string;
    subscribe?: (listener: () => void) => () => void;
  },
) {
  const allowed = new Set([
    ...(manifest.contributes.capabilities ?? []),
    ...(manifest.contributes.commands ?? []).map(({ id }) => id),
  ]);
  let disposed = false;
  let available = lifecycle.available() === true;
  const entries = new Set<{ bind: () => void; remove: () => void }>();
  const unsubscribe = lifecycle.subscribe?.(() => {
    const next = lifecycle.available() === true;
    if (available && !next) {
      // Unregistration aborts active requests, including uncooperative late results.
      for (const entry of entries) {
        entry.remove();
        entry.bind();
      }
    }
    available = next;
  });
  return {
    register<Input>(definition: CapabilityDefinition<Input>) {
      if (disposed) throw new Error('Plugin scope is disposed.');
      if (
        !allowed.has(definition.id) ||
        definition.owner !== 'plugin' ||
        definition.plugin !== manifest.id
      )
        throw new Error('Plugin capability was not declared by its manifest.');
      const bound = {
        ...definition,
        available: () => {
          const gate = lifecycle.available();
          return gate === true ? (definition.available?.() ?? true) : gate;
        },
      };
      const entry = {
        remove: () => {},
        bind: () => {
          entry.remove = host.register(bound);
        },
      };
      entry.bind();
      entries.add(entry);
      return () => {
        entry.remove();
        entries.delete(entry);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const entry of entries) entry.remove();
      entries.clear();
    },
  };
}
