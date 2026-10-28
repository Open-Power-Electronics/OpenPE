import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createPart, emptyCircuit, parseCircuit, serializeCircuit } from '../lib/circuit';
import {
  appendSchematic,
  createProject,
  exportKiCad,
  importDocument,
  parseProject,
  projectNativeFiles,
  serializeProject,
} from '../lib/project';
import { child, parseSExpr, writeSExpr } from '../lib/sexpr';
import { parseProject as parseServiceProject } from '../server/project-format.mjs';
import kicadSnapshots from '../lib/kicad-examples.json';
import referenceSnapshots from '../lib/reference-examples.json';

test('infinite-canvas schematics retain off-page coordinates without paper in projects or exports', () => {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', -508, 762));
  const project = createProject(circuit);
  const canonical = serializeProject(project);
  const roundtrip = parseProject(canonical);
  assert.deepEqual([roundtrip.schematic.parts[0].x, roundtrip.schematic.parts[0].y], [-508, 762]);
  assert.equal(child(parseSExpr(exportKiCad(project, 'schematic')), 'paper'), undefined);
  assert.equal(child(parseSExpr(serializeCircuit(emptyCircuit())), 'paper'), undefined);
  assert.ok(!(JSON.parse(canonical).schematic.kicad || []).some((n: string[]) => n[0] === 'paper'));
});

test('native import removes standard and custom paper settings while retaining every design object', () => {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', 381, -254));
  const source = serializeCircuit(circuit);
  const baseline = parseCircuit(source);
  for (const paper of [
    ['paper', '"A3"'],
    ['paper', '"A4"', 'portrait'],
    ['paper', '"User"', '800', '600'],
  ]) {
    const root = parseSExpr(source);
    root.push(paper);
    const imported = parseCircuit(writeSExpr(root));
    assert.deepEqual(imported, baseline);
    const project = importDocument(writeSExpr(root));
    assert.equal(child(project.schematic.original!, 'paper'), undefined);
    assert.equal(child(parseSExpr(exportKiCad(project, 'schematic')), 'paper'), undefined);
    assert.deepEqual(
      parseProject(serializeProject(project)).schematic.parts,
      parseProject(serializeProject(importDocument(source))).schematic.parts,
    );
  }
});

test('canonical paper metadata is rejected in primary and additional schematics by renderer and service', () => {
  const project = appendSchematic(createProject()).project;
  const canonical = JSON.parse(serializeProject(project));
  for (const extra of [false, true]) {
    const data = structuredClone(canonical);
    const schematic = extra ? data.additionalSchematics[0].schematic : data.schematic;
    schematic.kicad = [...(schematic.kicad || []), ['paper', '"A4"']];
    const source = JSON.stringify(data);
    assert.throws(() => parseProject(source), /Invalid OpenPE project/);
    assert.throws(() => parseServiceProject(source), /Invalid OpenPE project/);
  }
  const circuit = parseCircuit(serializeCircuit(emptyCircuit()));
  circuit.original!.push(['paper', '"A3"']);
  assert.throws(() => serializeProject(createProject(circuit)), /infinite canvas/);
});

test('all editable examples and bundled snapshots are paper-free and native exports agree', () => {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'upstream') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.openpe.json')) files.push(file);
      else if (entry.name.endsWith('.kicad_sch'))
        assert.equal(child(parseSExpr(readFileSync(file, 'utf8')), 'paper'), undefined, file);
    }
  };
  visit('examples');
  assert.equal(files.length, 0, 'Home projects use native KiCad files.');
  files.push(
    ...readdirSync('tests/fixtures/reference')
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join('tests/fixtures/reference', name)),
  );
  assert.equal(files.length, 9, 'Private snapshots cover the nine Home projects.');
  visit('tests/fixtures/kicad');
  visit('tests/fixtures/ti');
  files.push('tests/fixtures/rc-filter.openpe.json');
  assert.equal(files.length, 25);
  for (const file of files) {
    const project = parseProject(readFileSync(file, 'utf8'));
    assert.equal(
      file.startsWith(path.join('tests', 'fixtures', 'reference'))
        ? projectNativeFiles(project, path.basename(file, '.json') + '.kicad_pro').files.find(
            (item) => item.name.endsWith('.kicad_sch'),
          )!.source
        : exportKiCad(project, 'schematic'),
      readFileSync(
        file.startsWith(path.join('tests', 'fixtures', 'reference'))
          ? path.join(
              'examples',
              path.basename(file, '.json'),
              path.basename(file, '.json') + '.kicad_sch',
            )
          : file.replace(/\.openpe\.json$/, '.kicad_sch'),
        'utf8',
      ),
      file,
    );
  }
  for (const source of Object.values(kicadSnapshots))
    assert.equal(child(parseSExpr(source), 'paper'), undefined);
  for (const source of Object.values(referenceSnapshots))
    assert.doesNotThrow(() => parseProject(source));
});
