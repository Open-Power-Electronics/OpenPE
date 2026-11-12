const { app, safeStorage } = require('electron');
const { createServer } = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const path = require('node:path');
const { createCursorCredentialStore } = require('../electron/cursor-credential.cjs');

app.setPath('userData', process.env.OPENPE_DATA_DIR || path.join(app.getPath('appData'), 'OpenPE'));
app.setName('OpenPE');

function bridge(kind) {
  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  return { id, token, path: `/api/agent-${kind}/${id}` };
}

app.whenReady().then(async () => {
  let code = 1;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const tools = req.url?.startsWith('/api/agent-tools/');
      const questions = req.url?.startsWith('/api/agent-questions/');
      if (req.method !== 'POST' || (!tools && !questions)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(tools ? JSON.stringify({ result: { ok: true } }) : JSON.stringify({ answers: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const store = createCursorCredentialStore({
      directory: app.getPath('userData'),
      safeStorage,
    });
    const apiKey = await store.read();
    const { cursorCheckRequest, listCursorModels, loadCursorSdk, runCursorAgent } = await import(
      '../server/agent-cursor.mjs'
    );
    const sdk = await loadCursorSdk();
    const catalog = await listCursorModels(apiKey, sdk);
    const ids = catalog.models.map((model) => model.id);
    for (const model of catalog.models) console.log(`${model.id}\t${model.label}`);
    const requested = process.env.OPENPE_CURSOR_CHECK_MODEL;
    if (!requested)
      throw new Error(`Set OPENPE_CURSOR_CHECK_MODEL to one of: ${ids.join(', ')}`);
    const model = catalog.models.find((entry) => entry.id === requested);
    if (!model) throw new Error(`Set OPENPE_CURSOR_CHECK_MODEL to one of: ${ids.join(', ')}`);
    const rawParameter = process.env.OPENPE_CURSOR_CHECK_PARAMETER;
    let override;
    if (rawParameter !== undefined) {
      const split = rawParameter.indexOf('=');
      if (split <= 0 || !rawParameter.slice(split + 1))
        throw new Error('Set OPENPE_CURSOR_CHECK_PARAMETER to id=value.');
      override = { id: rawParameter.slice(0, split), value: rawParameter.slice(split + 1) };
    }
    const request = cursorCheckRequest(model, override);
    console.log(`model\t${request.model}`);
    if (request.effort) console.log(`effort\t${request.effort}`);
    for (const parameter of request.parameters || [])
      console.log(`parameter\t${parameter.id}\t${parameter.value}`);
    const tools = bridge('tools');
    const questions = bridge('questions');
    const events = [];
    const result = await runCursorAgent(
      'Reply with the single word ready.',
      { model: request.model, ...(request.effort ? { effort: request.effort } : {}), ...(request.parameters ? { parameters: request.parameters } : {}) },
      (event) => {
        events.push(event);
        if (event.type === 'text-delta') process.stdout.write(event.delta);
      },
      new AbortController().signal,
      {
        sdk,
        cursorCredential: { read: async () => apiKey },
        capabilities: {
          url: `http://127.0.0.1:${port}${tools.path}`,
          token: tools.token,
          call: async () => ({ ok: true }),
        },
        questions: {
          url: `http://127.0.0.1:${port}${questions.path}`,
          token: questions.token,
        },
      },
    );
    console.log(`\noutcome\t${result.outcome}`);
    if (result.outcome !== 'completed') throw new Error('Cursor check did not finish.');
    code = 0;
  } catch (error) {
    console.error(error.message);
  } finally {
    server.close();
    app.exit(code);
  }
});
