import AgentLogo from './AgentLogo';
import Select from './Select';
import { agentProviders } from '@/lib/agent-providers';

export type AgentPickerProps = {
  provider: string;
  agents: {
    id: string;
    available: boolean;
    installed?: boolean;
    version?: string;
    error?: string;
  }[];
  onChange: (provider: string) => void;
  disabled: boolean;
};

export default function AgentPicker({
  provider,
  agents,
  onChange,
  disabled,
  compact = false,
}: AgentPickerProps & { compact?: boolean }) {
  function description(id: string) {
    const agent = agents.find((entry) => entry.id === id);
    if (agent?.installed && !agent.available) return 'CLI detected · unavailable';
    if (!agent?.available) return 'CLI not detected';
    const version = agent.version?.match(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/)?.[0];
    return `CLI detected${version ? ` · ${version}` : ''}`;
  }
  return (
    <div className={compact ? 'rail-agent' : 'home-agent'}>
      <Select
        label="Choose agent"
        popupClassName={compact ? 'agent-menu rail-menu' : 'agent-menu'}
        popupPlacement={compact ? 'right' : 'bottom'}
        disabled={disabled}
        value={provider}
        onChange={onChange}
        icon={<AgentLogo provider={provider} />}
        showChevron={!compact}
        iconOnly={compact}
        options={agentProviders.map(({ id, name }) => ({
          value: id,
          label: name,
          icon: <AgentLogo provider={id} size={22} />,
          description: description(id),
          muted: !agents.find((agent) => agent.id === id)?.available,
        }))}
      />
    </div>
  );
}
