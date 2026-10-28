import test from 'node:test';
import assert from 'node:assert/strict';
import { createExample } from '../lib/examples';
import { exportKiCad, parseProject, serializeProject } from '../lib/project';
import { displayPartValue, partFields } from '../lib/library';
import { applyProposal } from '../lib/proposals';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import {
  parseProject as serviceParse,
  serializeProject as serviceSerialize,
} from '../server/project-format.mjs';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';
import { defaultAgentPreferences, restoreWorkspace } from '../lib/workspace-state';
import type { ProjectDocument } from '../lib/project-document';
import { createSession } from '../lib/chat-sessions';

test('one Source value drives the inspector, service, recovery, netlist and native export', () => {
  const project = createExample('kicad-buck');
  const document: ProjectDocument = JSON.parse(serializeProject(project));
  const component = document.schematic.components!.find((p) => p.reference === 'R101')!;
  assert.equal(component.value, '5');
  assert.equal(component.simulation?.valueFormat, 'r=${VALUE}');
  assert.equal(component.fields!['Sim.Params'], undefined);
  assert.ok(component.fieldLayout!['Sim.Params']);
  component.value = '17';
  const source = JSON.stringify(document);
  const reopened = parseProject(source);
  const part = reopened.schematic.parts.find((p) => p.id === component.id)!;
  assert.equal(displayPartValue(part), '17');
  assert.equal(partFields(part)['Sim.Params'], 'r=17');
  const canonical = serializeProject(reopened);
  assert.equal(serviceSerialize(serviceParse(source)), canonical);
  assert.equal(serializeProject(parseProject(canonical)), canonical);
  const config = defaultTransient(reopened.schematic);
  const deck = buildSpiceDeck(reopened.schematic, config);
  assert.equal(serviceDeck(serviceParse(source).schematic, config).netlist, deck.netlist);
  assert.match(deck.netlist, /^R\S* \S+ \S+ 17$/m);
  assert.doesNotMatch(deck.netlist, /\$\{VALUE\}/);
  const native = children(parseSExpr(exportKiCad(reopened, 'schematic')), 'symbol').find(
    (p) => val(child(p, 'uuid')) === part.id,
  )!;
  assert.equal(
    val(
      children(native, 'property').find((p) => val(p) === 'Sim.Params'),
      2,
    ),
    'r=17',
  );
  const id = crypto.randomUUID();
  const session = createSession();
  const recovery = restoreWorkspace({
    version: 2,
    activeDocumentId: id,
    ...defaultAgentPreferences,
    documents: [
      {
        id,
        source: canonical,
        dirty: false,
        sourceDraft: null,
        filename: 'Buck.openpe.json',
        sessions: [session],
        activeSessionId: session.id,
      },
    ],
  });
  assert.equal(recovery.documents[0].source, canonical);
});

test('Agent value edits update the shared electrical value and leave the input unchanged', () => {
  const project = createExample('kicad-buck');
  const before = serializeProject(project);
  const schematic = applyProposal(project.schematic, [
    { type: 'setValue', ref: 'R101', value: '22' },
  ]);
  const part = schematic.parts.find((p) => p.ref === 'R101')!;
  assert.equal(displayPartValue(part), '22');
  assert.equal(partFields(part)['Sim.Params'], 'r=22');
  assert.equal(serializeProject(project), before);
  assert.match(
    buildSpiceDeck(schematic, defaultTransient(schematic)).netlist,
    /^R\S* \S+ \S+ 22$/m,
  );
});

test('bindings preserve single-parameter spelling and compound source descriptions', () => {
  const project = createExample('kicad-buck');
  const part = project.schematic.parts.find((p) => p.ref === 'R101')!;
  part.fields = { ...partFields(part), 'Sim.Params': ' R = 5  ' };
  const source = serializeProject(project);
  const document: ProjectDocument = JSON.parse(source);
  assert.equal(
    document.schematic.components!.find((p) => p.id === part.id)!.simulation?.valueFormat,
    ' R = ${VALUE}  ',
  );
  assert.equal(
    partFields(parseProject(source).schematic.parts.find((p) => p.id === part.id)!)['Sim.Params'],
    ' R = 5  ',
  );
  const rectifier = createExample('kicad-rectifier');
  const rectifierDocument: ProjectDocument = JSON.parse(serializeProject(rectifier));
  const voltage = rectifierDocument.schematic.components!.find((p) => p.reference === 'V1')!;
  assert.equal(voltage.value, 'dc=0 ampl=1 f=1k ac=1');
  assert.equal(voltage.simulation?.valueFormat, '${VALUE}');
  assert.equal(voltage.fields!['Sim.Params'], undefined);
  const nativeFields = (source: string) =>
    children(parseSExpr(source), 'symbol').map((p) =>
      Object.fromEntries(children(p, 'property').map((f) => [val(f), val(f, 2)])),
    );
  assert.deepEqual(
    nativeFields(exportKiCad(parseProject(serializeProject(rectifier)), 'schematic')),
    nativeFields(exportKiCad(rectifier, 'schematic')),
  );
});

test('duplicate, recursive, malformed and oversized bindings fail in renderer and service', () => {
  const source = serializeProject(createExample('kicad-buck'));
  for (const mutate of [
    (p: any) => {
      p.fields['Sim.Params'] = 'r=99';
    },
    (p: any) => {
      p.value = '${SIM.PARAMS}';
    },
    (p: any) => {
      p.value = '${VALUE}';
    },
    (p: any) => {
      p.value = 'r=22';
    },
    (p: any) => {
      p.value = ' ';
    },
    (p: any) => {
      p.value = '1'.repeat(4096);
    },
    (p: any) => {
      p.simulation.valueFormat = 'r=22';
    },
    (p: any) => {
      p.simulation.valueFormat = 'r=${VALUE} c=${VALUE}';
    },
    (p: any) => {
      p.simulation.extra = true;
    },
    (p: any) => {
      p.simulation = null;
    },
  ]) {
    const document = JSON.parse(source);
    mutate(document.schematic.components.find((p: any) => p.reference === 'R101'));
    const invalid = JSON.stringify(document);
    assert.throws(() => parseProject(invalid), /Invalid OpenPE project/);
    assert.throws(() => serviceParse(invalid), /Invalid OpenPE project/);
  }
});
