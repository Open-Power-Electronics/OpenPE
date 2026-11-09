import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  agentCapabilityTools,
  validateAgentCapabilityCall,
  agentCapabilityLimits,
  agentCapabilityContent,
} from './agent-capabilities.mjs';

/** The helper can contact only its one ephemeral loopback capability endpoint.
 * @param {Record<string,string|undefined>} env
 */
export function agentMCPConnection(env = process.env) {
  const url = new URL(env.OPENPE_AGENT_BRIDGE_URL || 'about:blank');
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    !/^\/api\/agent-tools\/[0-9a-f-]{36}$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^[0-9a-f]{64}$/.test(env.OPENPE_AGENT_BRIDGE_TOKEN || '')
  )
    throw new Error('OpenPE capability connection is unavailable.');
  return { url: url.href, token: env.OPENPE_AGENT_BRIDGE_TOKEN };
}

/** @param {{input?:import('node:stream').Readable, output?:import('node:stream').Writable, env?:Record<string,string|undefined>, request?:typeof fetch}} options */
export function startAgentMCP({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  request = fetch,
} = {}) {
  const connection = agentMCPConnection(env);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const controls = new Set();
  const send = (message) => output.write(JSON.stringify(message) + '\n');
  let pending = 0;
  lines.on('line', async (line) => {
    if (Buffer.byteLength(line) > agentCapabilityLimits.inputBytes) {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'MCP request is too large.' },
      });
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } });
      return;
    }
    if (message.id === undefined) return;
    const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result });
    if (message.method === 'initialize')
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'openpe', version: '1.0.0' },
      });
    if (message.method === 'ping') return reply({});
    if (message.method === 'tools/list') return reply({ tools: agentCapabilityTools });
    if (message.method !== 'tools/call')
      return send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'This OpenPE adapter exposes only capability tools.' },
      });
    let control;
    try {
      const { name, arguments: args = {} } = message.params || {};
      validateAgentCapabilityCall(name, args);
      if (pending >= agentCapabilityLimits.pending)
        throw new Error('Too many pending capability requests.');
      control = new AbortController();
      controls.add(control);
      pending++;
      const response = await request(connection.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OpenPE-Agent-Token': connection.token },
        body: JSON.stringify({ tool: name, arguments: args }),
        signal:
          name === 'openpe_execute'
            ? control.signal
            : AbortSignal.any([
                control.signal,
                AbortSignal.timeout(agentCapabilityLimits.timeoutMs + 5000),
              ]),
        redirect: 'error',
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > agentCapabilityLimits.resultBytes + 1024)
        throw new Error('Capability result exceeds the adapter budget.');
      const result = JSON.parse(text);
      if (!response.ok || result.error)
        throw new Error(result.error || 'OpenPE rejected the request.');
      const content = agentCapabilityContent(name, args, result.result);
      reply({
        content: [
          {
            type: 'text',
            text: content.text,
          },
          ...(content.image ? [{ type: 'image', mimeType: 'image/png', data: content.image }] : []),
        ],
      });
    } catch (error) {
      reply({
        isError: true,
        content: [{ type: 'text', text: String(error.message).slice(0, 4000) }],
      });
    } finally {
      if (control) {
        pending--;
        controls.delete(control);
      }
    }
  });
  lines.on('close', () => {
    for (const control of controls) control.abort();
  });
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    startAgentMCP();
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
