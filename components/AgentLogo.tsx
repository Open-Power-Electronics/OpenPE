const agentLogos: Record<string, string> = {
  codex: 'codex.svg',
  claude: 'claude-code.svg',
  deepseek: 'deepseek-harness.svg',
  pi: 'pi.svg',
  cursor: 'cursor.svg',
};

export default function AgentLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  const logo = agentLogos[provider];
  if (!logo) return null;
  return (
    <img
      className="agent-brand"
      data-provider={provider}
      src={`/agents/${logo}`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
