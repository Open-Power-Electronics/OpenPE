import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// Same-turn text input only. This bridge cannot select providers, tools or hosts.
export function createAgentInputBridge({ sessionId, origin, emit, signal }) {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const requests = new Map();
  let handler,
    closed = false;
  const close = () => {
    closed = true;
    handler = undefined;
    requests.clear();
    signal.removeEventListener('abort', close);
  };
  signal.addEventListener('abort', close, { once: true });
  if (signal.aborted) close();
  return {
    id,
    close,
    register(accept) {
      if (closed) return;
      handler = accept;
      emit({ type: 'input-ready', runId: id, sessionId, token });
    },
    async submit(body, requestOrigin) {
      if (
        closed ||
        !handler ||
        requestOrigin !== origin ||
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 5 ||
        Object.keys(body).some(
          (key) => !['runId', 'sessionId', 'token', 'requestId', 'prompt'].includes(key),
        ) ||
        body.runId !== id ||
        body.sessionId !== sessionId ||
        typeof body.token !== 'string' ||
        Buffer.byteLength(body.token) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(body.token), Buffer.from(token)) ||
        typeof body.requestId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId) ||
        typeof body.prompt !== 'string' ||
        !body.prompt.trim() ||
        body.prompt.length > 16000
      )
        throw new Error('Steering input is invalid or its originating run is no longer available.');
      const previous = requests.get(body.requestId);
      if (previous) {
        if (previous.prompt !== body.prompt)
          throw new Error('Steering request identity was reused.');
        return previous.result;
      }
      if (requests.size >= 32) throw new Error('The steering limit for this run has been reached.');
      let accepted = false;
      const acknowledge = () => {
        if (closed || signal.aborted || accepted) return;
        accepted = true;
        emit({ type: 'input-accepted', requestId: body.requestId, sessionId, prompt: body.prompt });
      };
      const result = Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          if (closed) throw new Error('The originating Agent run has completed.');
          return handler(body.prompt, acknowledge);
        })
        .then(() => {
          if (!accepted) throw new Error('The Agent did not acknowledge steering input.');
          return { ok: true };
        });
      requests.set(body.requestId, { prompt: body.prompt, result });
      return result;
    },
  };
}
