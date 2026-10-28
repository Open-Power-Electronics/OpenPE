import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpiceDeck } from '../lib/spice';
import { createProject, serializeProject } from '../lib/project';
import { defaultTransient } from '../lib/spice';
import { adaptSpiceModels } from '../server/spice-model-adapters.mjs';
import { registerSpice } from '../server/spice.mjs';
import { switchingStageFixture } from './fixtures/switching-stage';

const id = 'reference-lmr70503';
const digest = '1d661a243a8a44cab8f6e67448dfdafcc96249dea54f35927b25283e01e7aba9';
const preparedModel = path.resolve('examples', 'models', `${id}-${digest}.lib`);
const deck = (): SpiceDeck => ({
  modelIds: [id],
  compatibility: 'ps',
  netlist: `OpenPE isolated adapter fixture
.options itl4=1000 reltol=0.005 method=gear rshunt=1e9
.include example-model-0.lib
X6 n3 n1 0 n5 n6 n2 n4 LMR70503_TRANS
.save v(n2)
.control
tran 2e-7 .01 0 2e-7 uic
linearize
wrdata waveforms.txt v(n2)
.endc
.end
`,
  stop: 0.01,
  assumptions: ['Original fixture assumption.'],
  traces: [{ label: 'V(VOUT)', vector: 'v(n2)', unit: 'V' }],
});

async function originalModel(context: { skip(message: string): void }) {
  try {
    const bytes = await readFile(preparedModel);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    context.skip('Prepare the pinned offline Home model to verify the compatibility structure.');
    return undefined;
  }
}

test('unrelated models retain deck identity and cannot activate compatibility through extra flags', () => {
  const unrelated = { ...deck(), modelIds: ['other-official-model'], modelAdapter: id };
  const before = structuredClone(unrelated);
  assert.equal(adaptSpiceModels(unrelated, new Map([[id, Buffer.from('unverified')]])), unrelated);
  assert.deepEqual(unrelated, before);
  const generic = { ...deck(), modelIds: undefined };
  assert.equal(adaptSpiceModels(generic, new Map()), generic);
});

test('LMR70503 adaptation fails closed for missing, altered, and substituted original bytes', () => {
  assert.throws(() => adaptSpiceModels(deck(), new Map()), /original model bytes are missing/);
  for (const bytes of [Buffer.alloc(0), Buffer.from('different vendor model')])
    assert.throws(() => adaptSpiceModels(deck(), new Map([[id, bytes]])), /pinned SHA-256/);
  const repeated = { ...deck(), modelIds: [id, id] };
  assert.throws(() => adaptSpiceModels(repeated, new Map()), /referenced exactly once/);
});

test('pinned original bytes produce the proven RC-preserving private controller without mutations', async (context) => {
  const bytes = await originalModel(context);
  if (!bytes) return;
  const originalBytes = Buffer.from(bytes),
    input = deck(),
    before = structuredClone(input);
  const result = adaptSpiceModels(input, new Map([[id, bytes]]));
  assert.notEqual(result, input);
  assert.deepEqual(input, before);
  assert.deepEqual(bytes, originalBytes);
  assert.equal(result.compatibility, 'psa');
  assert.equal(result.stop, input.stop);
  assert.equal(result.traces, input.traces);
  assert.match(result.netlist, /^X6 n3 n1 0 n5 n6 n2 n4 OPENPE_COMPAT_LMR70503_TRANS$/m);
  assert.match(result.netlist, /^\.include example-model-0\.lib$/m);
  assert.match(result.netlist, /^\.options itl4=1000 reltol=0.005 method=gear rshunt=1e9$/m);
  assert.match(result.netlist, /^tran 2e-7 .01 0 2e-7 uic$/m);
  for (const name of ['LMR70503_TRANS', 'CTRL_ONE_SHOT', 'ONE_SHOT']) {
    assert.equal(
      (result.netlist.match(new RegExp(`^\\.subckt OPENPE_COMPAT_${name}\\b`, 'gmi')) || []).length,
      1,
    );
    assert.equal(
      (result.netlist.match(new RegExp(`^\\.ends OPENPE_COMPAT_${name}\\b`, 'gmi')) || []).length,
      1,
    );
  }
  const timer = /^\.subckt one_shot\b[\s\S]*?^\.ends one_shot\b/im.exec(bytes.toString('utf8'))![0];
  for (const line of timer.split(/\r?\n/).filter((line) => /^(?:r_|c_|s_|\.model)/i.test(line)))
    assert.ok(result.netlist.includes(line), `Original timer/reset element must remain: ${line}`);
  assert.match(result.netlist, /E_SET set_v 0 value=\{if\(v\(in\)>0\.5 & v\(meas\)<0\.5,1,0\)\}/);
  assert.match(result.netlist, /E_RESET reset_v 0 value=\{if\(v\(meas\)>=0\.5,1,0\)\}/);
  assert.match(
    result.netlist,
    /d_srlatch\(sr_delay=1p enable_delay=1p set_delay=1p reset_delay=1p/,
  );
  assert.match(
    result.netlist,
    /dac_bridge\(out_low=0 out_high=1 out_undef=0\.5 input_load=0 t_rise=1p t_fall=1p\)/,
  );
  assert.doesNotMatch(result.netlist, /OPENPE_EXPERIMENTAL|pw_array|\.model\s+\S+\s+oneshot\(/i);
  assert.match(result.assumptions.at(-1)!, /approximate.*near-reset/i);
  assert.deepEqual(result.assumptions.slice(0, -1), input.assumptions);
});

test('all target calls are adapted while other models and includes remain intact', async (context) => {
  const bytes = await originalModel(context);
  if (!bytes) return;
  const input = deck();
  input.modelIds = ['other-official-model', id];
  input.netlist = input.netlist
    .replace(
      '.include example-model-0.lib',
      '.include example-model-0.lib\n.include example-model-1.lib',
    )
    .replace('.save', 'X7 a b c d e f g LMR70503_TRANS\nX8 a b c d e OTHER_TRANS\n.save');
  const result = adaptSpiceModels(input, new Map([[id, bytes]]));
  assert.equal((result.netlist.match(/^X\d+ .+ OPENPE_COMPAT_LMR70503_TRANS$/gm) || []).length, 2);
  assert.match(result.netlist, /^X8 a b c d e OTHER_TRANS$/m);
  assert.match(result.netlist, /^\.include example-model-0\.lib$/m);
  assert.match(result.netlist, /^\.include example-model-1\.lib$/m);
});

test('unexpected deck blocks, includes, or terminal counts fail before solver execution', async (context) => {
  const bytes = await originalModel(context);
  if (!bytes) return;
  for (const netlist of [
    deck().netlist.replace('.save', '.save v(extra)\n.save'),
    deck().netlist.replace('.save v(n2)\n', ''),
    deck().netlist.replace('.include example-model-0.lib', ''),
    deck().netlist.replace(
      '.include example-model-0.lib',
      '.include example-model-0.lib\n.include example-model-0.lib',
    ),
    deck().netlist.replace('X6 n3 n1 0 n5 n6 n2 n4 LMR70503_TRANS\n', ''),
    deck().netlist.replace('n3 n1 0 n5 n6 n2 n4', 'n3 n1 0 n5 n6 n2'),
    deck().netlist.replace(
      '.save',
      '.subckt OPENPE_COMPAT_ONE_SHOT in out\n.ends OPENPE_COMPAT_ONE_SHOT\n.save',
    ),
  ])
    assert.throws(
      () => adaptSpiceModels({ ...deck(), netlist }, new Map([[id, bytes]])),
      /compatibility preparation failed/,
    );
  const duplicatedBlock = Buffer.concat([
    bytes,
    Buffer.from('\n.subckt one_shot in out\n.ends one_shot\n'),
  ]);
  assert.throws(() => adaptSpiceModels(deck(), new Map([[id, duplicatedBlock]])), /pinned SHA-256/);
});

test('simulation route rejects renderer adapter flags and private netlists before execution', async () => {
  let calls = 0;
  let handler!: (request: unknown, response: unknown) => Promise<void>;
  const service = registerSpice(
    {
      get() {},
      post(route: string, callback: typeof handler) {
        assert.ok(['/api/simulation/transient', '/api/simulation/result'].includes(route));
        if (route === '/api/simulation/transient') handler = callback;
      },
    },
    async () => {
      calls++;
      throw new Error('Must reject before execution.');
    },
  );
  try {
    const circuit = switchingStageFixture();
    const body = {
      source: serializeProject(createProject(circuit)),
      config: defaultTransient(circuit),
    };
    for (const extra of [
      { modelAdapter: id },
      { compatibility: 'psa' },
      { netlist: deck().netlist },
    ]) {
      let code = 0;
      let result: { error: string } | undefined;
      const response = {
        status(value: number) {
          code = value;
          return this;
        },
        json(value: { error: string }) {
          result = value;
        },
      };
      await handler({ body: { ...body, ...extra } }, response);
      assert.equal(code, 400);
      assert.match(result!.error, /Send a project source/);
    }
    assert.equal(calls, 0);
  } finally {
    service.close();
  }
});
