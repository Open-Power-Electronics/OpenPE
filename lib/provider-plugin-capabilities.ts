import type { CapabilityHost } from '../api/capabilities';
import { api } from './bridge';

const provider = { enum: ['codex', 'claude'] };
export function registerProviderPluginCapabilities(host: CapabilityHost) {
  const dispose = [
    host.register<{ provider: string; refresh?: boolean }>({
      owner: 'host',
      id: 'provider.plugins.list',
      kind: 'query',
      description:
        'Read installed Agent provider plugins and the actions supported by that provider.',
      inputSchema: {
        type: 'object',
        properties: { provider, refresh: { type: 'boolean' } },
        required: ['provider'],
        additionalProperties: false,
      },
      handler: async ({ provider, refresh }, { signal }) =>
        (
          await api(`plugins?provider=${provider}${refresh ? '&refresh=true' : ''}`, { signal })
        ).json(),
    }),
    host.register<{ provider: string; action: string; id: string }>({
      owner: 'host',
      id: 'provider.plugins.change',
      kind: 'command',
      mutation: 'external',
      review: 'optional',
      description:
        'Manage an explicitly identified provider plugin through the same bounded provider adapter as Plugins.',
      inputSchema: {
        type: 'object',
        properties: {
          provider,
          action: { enum: ['install', 'uninstall', 'enable', 'disable'] },
          id: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['provider', 'action', 'id'],
        additionalProperties: false,
      },
      handler: async (input, { signal, emit }) => {
        const result = await (
          await api('plugins', { method: 'POST', body: JSON.stringify(input), signal })
        ).json();
        emit('provider.plugins.changed', { provider: input.provider });
        return result;
      },
    }),
  ];
  return () => {
    for (const unregister of dispose) unregister();
  };
}
