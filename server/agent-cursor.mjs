import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isProviderReasoningEffort } from './agent-provider-format.mjs';
import { validModelId } from './model-id.mjs';
import { startAgentMCP, agentMcpTools } from './agent-mcp.mjs';

const require = createRequire(import.meta.url);
const mcpScript = fileURLToPath(new URL('./agent-mcp.mjs', import.meta.url));

function cursorSdkVersion() {
  let dir = path.dirname(require.resolve('@cursor/sdk'));
  for (let depth = 0; depth < 6; depth++) {
    const file = path.join(dir, 'package.json');
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed.name === '@cursor/sdk' && typeof parsed.version === 'string' && parsed.version)
        return parsed.version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Cursor SDK version is unavailable.');
}
const startupLimitMs = 30000;
const textLimit = 2_000_000;
// SDK 1.3.1 expands `mcp` to these proto tools. Deny wins, so the resource and
// auth tools are removed and any newly expanded name fails the proof below.
const disallowedTools = [
  'shell',
  'read',
  'edit',
  'grep',
  'glob',
  'ls',
  'task',
  'webSearch',
  'delete',
  'readLints',
  'webFetch',
  'semSearch',
  'updateTodos',
  'readTodos',
  'askQuestion',
  'await',
  'generateImage',
  'applyAgentDiff',
  'list_mcp_resources_tool_call',
  'read_mcp_resource_tool_call',
  'mcp_auth_tool_call',
];
const cursorBuiltinTools = ['get_mcp_tools_tool_call', 'mcp_tool_call'];
const cursorMcpTools = ['openpe_ask_user', 'openpe_execute', 'openpe_observe', 'openpe_query'];

export async function loadCursorSdk() {
  const sdk = await import('@cursor/sdk');
  const version = cursorSdkVersion();
  if (typeof sdk.Agent?.create !== 'function' || typeof sdk.Cursor?.models?.list !== 'function')
    throw new Error('Cursor SDK did not export its local agent runtime.');
  if (typeof sdk.JsonlLocalAgentStore !== 'function' || typeof sdk.emptyFs !== 'function')
    throw new Error('Cursor SDK did not export its local isolation runtime.');
  return {
    Agent: sdk.Agent,
    Cursor: sdk.Cursor,
    JsonlLocalAgentStore: sdk.JsonlLocalAgentStore,
    emptyFs: sdk.emptyFs,
    CursorAgentError: sdk.CursorAgentError,
    version,
  };
}

export async function readCursorApiKey(credential) {
  if (!credential || typeof credential.read !== 'function')
    throw new Error('Cursor API key is not configured.');
  const key = await credential.read();
  if (typeof key !== 'string' || !key) throw new Error('Cursor API key is not configured.');
  return key;
}

function exposeError(error, apiKey) {
  const message = error instanceof Error ? error.message : String(error);
  if (apiKey && message.includes(apiKey)) return new Error('Cursor rejected the stored API key.');
  return error instanceof Error ? error : new Error(message.slice(0, 500));
}

const parameterIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const parameterValuePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function cursorModelError(model, message) {
  throw new Error(`Cursor model ${model?.id || '(missing id)'} ${message}`);
}

function cursorCatalogLabel(model, identity, label, kind) {
  if (label === undefined) return identity;
  if (typeof label !== 'string') cursorModelError(model, `has an invalid ${kind} label.`);
  const cleaned = label.replace(/\p{Cf}/gu, '');
  if (!cleaned || cleaned.length > 100 || /[\u0000-\u001F\u007F]/.test(cleaned))
    cursorModelError(model, `has an invalid ${kind} label.`);
  return cleaned;
}

/** ModelParameterDefinition entries are the selectable parameters. Ids that appear only on a variant stay out of the request. */
export function definedCursorModel(model) {
  if (!model || !validModelId(model.id)) cursorModelError(model, 'is not a catalog model.');
  const rawParameters = model.parameters === undefined ? [] : model.parameters;
  if (!Array.isArray(rawParameters) || rawParameters.length > 16)
    cursorModelError(model, 'has invalid parameters.');
  const parameters = [];
  const ids = new Set();
  for (const parameter of rawParameters) {
    if (!parameter || !parameterIdPattern.test(parameter.id) || ids.has(parameter.id))
      cursorModelError(model, 'has an invalid parameter id.');
    ids.add(parameter.id);
    if (!Array.isArray(parameter.values) || parameter.values.length < 1 || parameter.values.length > 32)
      cursorModelError(model, `parameter ${parameter.id} has invalid values.`);
    const values = [];
    const seen = new Set();
    for (const entry of parameter.values) {
      if (!entry || !parameterValuePattern.test(entry.value) || seen.has(entry.value))
        cursorModelError(model, `parameter ${parameter.id} has an invalid value.`);
      seen.add(entry.value);
      values.push({
        value: entry.value,
        label: cursorCatalogLabel(model, entry.value, entry.displayName, parameter.id),
      });
    }
    parameters.push({
      id: parameter.id,
      label: cursorCatalogLabel(model, parameter.id, parameter.displayName, parameter.id),
      values,
    });
  }
  const effortMatches = parameters.filter((parameter) =>
    parameter.values.every((entry) => isProviderReasoningEffort('cursor', entry.value)),
  );
  if (effortMatches.length > 1) cursorModelError(model, 'exposes multiple reasoning efforts.');
  if (!Array.isArray(model.variants) || model.variants.length < 1 || model.variants.length > 512)
    cursorModelError(model, 'has no catalog variants.');
  const defaults = model.variants.filter((variant) => variant?.isDefault === true);
  if (defaults.length !== 1) cursorModelError(model, 'has no single catalog default.');
  const variants = [];
  for (const variant of model.variants) {
    if (!variant || !Array.isArray(variant.params))
      cursorModelError(model, 'has an invalid variant.');
    const seen = new Set();
    const params = [];
    for (const param of variant.params) {
      if (!param || typeof param.id !== 'string' || typeof param.value !== 'string' || seen.has(param.id))
        cursorModelError(model, 'has an invalid variant.');
      seen.add(param.id);
      const defined = parameters.find((parameter) => parameter.id === param.id);
      if (!defined) continue;
      if (!defined.values.some((entry) => entry.value === param.value))
        cursorModelError(model, `variant uses unknown value ${param.value} for ${param.id}.`);
      params.push({ id: param.id, value: param.value });
    }
    variants.push({ params });
  }
  const defaultParams = defaults[0].params;
  for (const parameter of parameters) {
    const match = Array.isArray(defaultParams)
      ? defaultParams.find((param) => param?.id === parameter.id)
      : undefined;
    if (!match || !parameter.values.some((entry) => entry.value === match.value))
      cursorModelError(model, `has no catalog default for ${parameter.id}.`);
    parameter.default = match.value;
  }
  return { id: model.id, parameters, effort: effortMatches[0], variants };
}

export function cursorCatalogEntry(model) {
  if (!model || !validModelId(model.id)) return null;
  const defined = definedCursorModel(model);
  return {
    id: defined.id,
    label: typeof model.displayName === 'string' ? model.displayName.slice(0, 100) : model.id,
    description:
      typeof model.description === 'string' ? model.description.slice(0, 300) : model.id,
    efforts: defined.effort ? defined.effort.values.map((entry) => entry.value) : [],
    ...(defined.effort ? { effortParameter: defined.effort.id } : {}),
    parameters: defined.parameters.map((parameter) => ({
      id: parameter.id,
      label: parameter.label,
      values: parameter.values.map((entry) => ({ value: entry.value, label: entry.label })),
      default: parameter.default,
    })),
  };
}

export function validCursorRequestParameters(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return false;
  const ids = new Set();
  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('value')) return false;
    if (typeof item.id !== 'string' || typeof item.value !== 'string' || ids.has(item.id))
      return false;
    ids.add(item.id);
    return parameterIdPattern.test(item.id) && parameterValuePattern.test(item.value);
  });
}

export function cursorCheckRequest(entry, override) {
  if (!entry || !Array.isArray(entry.parameters))
    throw new Error('Cursor catalog entry has no parameters.');
  if (override !== undefined) {
    if (
      !override ||
      typeof override.id !== 'string' ||
      typeof override.value !== 'string' ||
      !entry.parameters.some((parameter) => parameter.id === override.id)
    )
      throw new Error(
        `Cursor parameter ${override?.id || '(missing id)'} is not offered. Ids: ${entry.parameters
          .map((parameter) => parameter.id)
          .join(', ')}`,
      );
  }
  const parameters = [];
  let effort;
  for (const parameter of entry.parameters) {
    const value = override?.id === parameter.id ? override.value : parameter.default;
    if (!parameter.values?.some((item) => item.value === value))
      throw new Error(
        `Cursor parameter ${parameter.id} does not offer ${value}. Values: ${(parameter.values || [])
          .map((item) => item.value)
          .join(', ')}`,
      );
    if (parameter.id === entry.effortParameter) effort = value;
    else parameters.push({ id: parameter.id, value });
  }
  if (entry.effortParameter && effort === undefined)
    throw new Error('This Cursor model does not expose the named reasoning effort.');
  if (!entry.effortParameter && effort !== undefined)
    throw new Error('This Cursor model does not expose a reasoning effort.');
  return {
    model: entry.id,
    ...(effort !== undefined ? { effort } : {}),
    ...(parameters.length ? { parameters } : {}),
  };
}

export function cursorModelSelection(model, request = {}) {
  const defined = definedCursorModel(model);
  const requested = request.parameters === undefined ? [] : request.parameters;
  if (!Array.isArray(requested)) throw new Error('Invalid Cursor model parameters.');
  if (defined.effort) {
    if (!defined.effort.values.some((entry) => entry.value === request.effort))
      throw new Error('Choose a reasoning effort offered for this Cursor model.');
  } else if (request.effort !== undefined) {
    throw new Error('This Cursor model does not expose a reasoning effort.');
  }
  const generic = defined.parameters.filter((parameter) => parameter !== defined.effort);
  const seen = new Set();
  for (const item of requested) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id))
      throw new Error('Invalid Cursor model parameters.');
    seen.add(item.id);
    if (!generic.some((parameter) => parameter.id === item.id))
      throw new Error(`Cursor model ${defined.id} does not offer parameter ${item.id}.`);
  }
  for (const parameter of generic)
    if (!seen.has(parameter.id))
      throw new Error(`Choose a value for Cursor parameter ${parameter.id}.`);
  const params = defined.parameters.map((parameter) => {
    const value =
      parameter === defined.effort
        ? request.effort
        : requested.find((item) => item.id === parameter.id).value;
    if (!parameter.values.some((entry) => entry.value === value))
      throw new Error(`Cursor parameter ${parameter.id} does not offer ${value}.`);
    return { id: parameter.id, value };
  });
  if (
    params.length &&
    !defined.variants.some((variant) =>
      params.every((param) =>
        variant.params.some((entry) => entry.id === param.id && entry.value === param.value),
      ),
    )
  )
    throw new Error(`Cursor model ${defined.id} has no variant for the selected parameters.`);
  // SDK 1.3.1 derives maxMode when every variant consistent with these params has isMaxMode.
  return params.length ? { id: defined.id, params } : { id: defined.id };
}

export async function listCursorModels(apiKey, sdk, signal) {
  const catalog = await cursorModelCatalog(apiKey, sdk);
  if (signal?.aborted) throw new Error('Model loading cancelled.');
  return { models: catalog.models };
}

function sameNames(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const names = [...actual].sort();
  const wanted = [...expected].sort();
  return names.every((name, index) => name === wanted[index]);
}

async function cursorModelCatalog(apiKey, sdk) {
  const models = await sdk.Cursor.models.list({ apiKey });
  if (!Array.isArray(models) || models.length > 500)
    throw new Error('Cursor returned an invalid model catalog.');
  const catalog = [];
  for (const model of models) {
    const entry = cursorCatalogEntry(model);
    if (entry) catalog.push(entry);
  }
  if (!catalog.length) throw new Error('Cursor returned no usable models.');
  return { models: catalog, raw: models };
}

export async function proveCursorMcpTools(env) {
  const declared = agentMcpTools(env).map((tool) => tool.name);
  if (!sameNames(declared, cursorMcpTools))
    throw new Error(`OpenPE MCP declared ${declared.join(', ') || 'no tools'}.`);
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  const received = [];
  output.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      received.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  const lines = startAgentMCP({
    input,
    output,
    env,
    request: async () => {
      throw new Error('Tool proof must not call the bridge.');
    },
  });
  try {
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    for (let i = 0; i < 50 && !received.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const names = received[0]?.result?.tools?.map((tool) => tool.name);
    if (!sameNames(names, cursorMcpTools))
      throw new Error(`OpenPE MCP exposed ${names?.join(', ') || 'no tools'}.`);
  } finally {
    input.end();
    lines.close();
  }
}

export function assertCursorSdkTools(agent, expected) {
  const options = agent?.options;
  if (!options || !Array.isArray(options.allowedProtoTools) || !Array.isArray(options.disallowedProtoTools))
    throw new Error('Cursor SDK cannot prove the effective tool set exposed to the model.');
  const local = options.local;
  if (local?.cwd !== expected.cwd)
    throw new Error('Cursor SDK working directory is not the private temporary directory.');
  if (!Array.isArray(local?.settingSources) || local.settingSources.length !== 0)
    throw new Error('Cursor SDK loaded ambient settings.');
  if (local?.sandboxOptions?.enabled !== false)
    throw new Error('Cursor SDK sandbox state is not explicit.');
  if (!local?.fs) throw new Error('Cursor SDK is using the host filesystem.');
  if (local.customTools || options.agents || options.cloud)
    throw new Error('Cursor SDK enabled custom tools, subagents, or a cloud runtime.');
  const server = options.mcpServers?.openpe;
  const servers = options.mcpServers ? Object.keys(options.mcpServers) : [];
  if (servers.length !== 1 || !server || server.type !== 'stdio' || server.command !== process.execPath)
    throw new Error('Cursor SDK did not keep the single OpenPE MCP server.');
  if (!Array.isArray(server.args) || server.args.length !== 1 || server.args[0] !== mcpScript)
    throw new Error('Cursor SDK MCP server is not the OpenPE adapter.');
  if (server.cwd !== expected.cwd) throw new Error('Cursor SDK MCP server is not in the private directory.');
  const env = server.env;
  const values = env ? Object.values(env) : [];
  if (
    !env ||
    env.ELECTRON_RUN_AS_NODE !== '1' ||
    env.OPENPE_AGENT_BRIDGE_TOKEN !== expected.capabilityToken ||
    env.OPENPE_QUESTIONS_TOKEN !== expected.questionToken ||
    values.includes(expected.apiKey) ||
    Object.hasOwn(env, 'CURSOR_API_KEY')
  )
    throw new Error('Cursor MCP environment is not isolated.');
  const denied = new Set(options.disallowedProtoTools);
  const effective = options.allowedProtoTools.filter((name) => !denied.has(name)).sort();
  if (!sameNames(effective, cursorBuiltinTools))
    throw new Error(
      `Cursor SDK exposed built-in tools ${effective.join(', ') || 'none'}.`,
    );
}

async function withStartup(signal, timeoutMs, work) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cursor startup timed out.')), timeoutMs);
  });
  const cancelled = new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('Cursor startup cancelled.'), { cancelled: true }));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  try {
    return await Promise.race([work(), timeout, cancelled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} prompt
 * @param {{model?:string, effort?:string, parameters?:{id:string, value:string}[], annotations?:{image:{dataUrl:string}}[]}} request
 * @param {(event:any)=>void} emit
 * @param {AbortSignal} signal
 */
export async function runCursorAgent(prompt, request, emit, signal, options) {
  const sdk = options.sdk || (await (options.loadCursorSdk || loadCursorSdk)());
  let apiKey = '';
  try {
    apiKey = await readCursorApiKey(options.cursorCredential);
    if (!request.model) throw new Error('Choose a Cursor model from the catalog.');
    if (!options.capabilities?.url || !options.capabilities.token)
      throw new Error('Cursor requires the OpenPE capability bridge.');
    if (!options.questions?.url || !options.questions.token)
      throw new Error('Cursor requires the OpenPE question bridge.');
    const env = {
      ELECTRON_RUN_AS_NODE: '1',
      OPENPE_AGENT_BRIDGE_URL: options.capabilities.url,
      OPENPE_AGENT_BRIDGE_TOKEN: options.capabilities.token,
      OPENPE_QUESTIONS_URL: options.questions.url,
      OPENPE_QUESTIONS_TOKEN: options.questions.token,
    };
    if (signal.aborted) return { outcome: 'cancelled' };
    emit({ type: 'status', stage: 'starting', text: 'Checking Cursor tool isolation…' });
    await proveCursorMcpTools(env);
    const catalog = await cursorModelCatalog(apiKey, sdk);
    if (signal.aborted) return { outcome: 'cancelled' };
    const raw = catalog.raw.find((model) => model?.id === request.model);
    if (!catalog.models.some((model) => model.id === request.model) || !raw)
      throw new Error('Choose a Cursor model from the catalog.');
    const selection = cursorModelSelection(raw, request);
    emit({
      type: 'agent-info',
      model: selection.id,
      ...(request.effort ? { reasoningEffort: request.effort } : {}),
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'openpe-cursor-'));
    const created = sdk.Agent.create({
      apiKey,
      model: selection,
      tools: ['mcp'],
      disallowedTools,
      mcpServers: {
        openpe: {
          type: 'stdio',
          command: process.execPath,
          args: [mcpScript],
          cwd: directory,
          env,
        },
      },
      local: {
        cwd: directory,
        settingSources: [],
        sandboxOptions: { enabled: false },
        enableAgentRetries: false,
        store: new sdk.JsonlLocalAgentStore(path.join(directory, 'store')),
        fs: sdk.emptyFs(),
      },
    });
    let agent;
    try {
      try {
        agent = await withStartup(
          signal,
          options.timeoutMs || startupLimitMs,
          () => created,
        );
      } catch (error) {
        void created.then((value) => value?.[Symbol.asyncDispose]?.()).catch(() => {});
        throw error;
      }
      assertCursorSdkTools(agent, {
        cwd: directory,
        apiKey,
        capabilityToken: options.capabilities.token,
        questionToken: options.questions.token,
      });
      if (signal.aborted) return { outcome: 'cancelled' };
      emit({ type: 'status', stage: 'waiting', text: 'Waiting for the model…' });
      const images = (request.annotations || []).map(({ image }) => ({
        data: image.dataUrl.slice('data:image/png;base64,'.length),
        mimeType: 'image/png',
      }));
      const message = images.length ? { text: prompt, images } : prompt;
      let run;
      let text = '';
      const abort = () => {
        if (!run) return;
        if (!run.supports('cancel'))
          throw new Error('Cursor SDK cannot cancel the run.');
        return run.cancel();
      };
      const onAbort = () => {
        void Promise.resolve(abort()).catch((error) => {
          emit({ type: 'error', text: exposeError(error, apiKey).message });
        });
      };
      signal.addEventListener('abort', onAbort);
      try {
        const started = performance.now();
        run = await agent.send(message);
        if (signal.aborted) await abort();
        for await (const event of run.stream()) {
          if (signal.aborted) break;
          if (event.type === 'assistant') {
            for (const block of event.message?.content || []) {
              if (block.type !== 'text' || !block.text) continue;
              text += block.text;
              if (text.length > textLimit) throw new Error('Agent response exceeds the 2 MB limit.');
              emit({ type: 'text-delta', delta: block.text });
            }
          } else if (event.type === 'thinking' && event.text) {
            emit({ type: 'process', id: 'cursor-thinking', text: event.text, append: true });
          }
        }
        const result = await run.wait();
        emit({ type: 'timing', timings: { completedMs: Math.round(performance.now() - started) } });
        if (signal.aborted || result.status === 'cancelled') return { outcome: 'cancelled' };
        if (result.status === 'finished') return { outcome: 'completed' };
        emit({
          type: 'error',
          text: exposeError(
            new Error(result.error?.message || 'Cursor run failed.'),
            apiKey,
          ).message.slice(0, 500),
        });
        return { outcome: 'failed' };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    } finally {
      await agent?.[Symbol.asyncDispose]?.();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  } catch (error) {
    if (signal.aborted) return { outcome: 'cancelled' };
    throw exposeError(error, apiKey);
  }
}
