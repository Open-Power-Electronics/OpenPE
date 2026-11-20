import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectCore } from '../core/project-core';
import type { RuleCheckResult } from '../lib/design-rule-checks';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';
import { modelCadFromProject } from '../lib/model-cad';
import { partFields } from '../lib/library';
import { child, children, quote } from '../lib/sexpr';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
} from '../plugins/spice-simulation/domain/spice';
import { buildSpiceDeck as serviceDeck } from '../plugins/spice-simulation/host/spice-format.mjs';
import {
  defaultThermalConfig,
  prepareThermalModel,
} from '../plugins/layout-thermal/domain/thermal';
import { atomicWrite } from '../server/atomic-write.mjs';
import { readProjectModelFile } from '../server/project-model-files.mjs';
import { projectDatasheetContext } from '../lib/example-datasheets';

const { readNativeProject, writeNativeProject } = createRequire(import.meta.url)(
  '../electron/native-project.cjs',
);
const byName = (bundle: KiCadProjectFiles) => ({
  ...bundle,
  files: [...bundle.files].sort((a, b) => a.name.localeCompare(b.name)),
});

// Read the actual files through the ordinary native reader. No example factory,
// Home catalog opening, provenance injection, private snapshot or solver cache.
for (const entry of homeExampleCatalog) {
  test(`${entry.file}: ordinary import and renamed native copy retain executable design inputs`, async (t) => {
    const originalPath = path.resolve(homeExampleNativePath(entry.id));
    const native = await readNativeProject(originalPath);
    const project = projectFromNativeFiles(native);
    assert.equal(projectDatasheetContext(project).status, 'available');
    assert.deepEqual(
      byName(projectNativeFiles(project)),
      byName(native),
      'Clean import preserves native bytes.',
    );
    assert.equal(simulationSupportError(project.schematic), '');
    const deck = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
    assert.deepEqual(serviceDeck(project.schematic, defaultTransient(project.schematic)), deck);

    const directory = await mkdtemp(path.join(tmpdir(), 'openpe-portability-'));
    t.after(async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
      assert.ok(path.basename(directory).startsWith('openpe-portability-'));
      assert.equal((await lstat(directory)).isSymbolicLink(), false);
      await rm(directory, { recursive: true, force: true });
    });
    const destination = path.join(directory, 'Customer power supply.kicad_pro');
    const copy = projectNativeFiles(project, path.basename(destination));
    await writeNativeProject(destination, copy, atomicWrite);
    const reopenedFiles = await readNativeProject(destination);
    const reopened = projectFromNativeFiles(reopenedFiles);
    assert.equal(projectDatasheetContext(reopened).status, 'available');
    assert.equal(reopenedFiles.entry, path.basename(destination));
    assert.deepEqual(
      buildSpiceDeck(reopened.schematic, defaultTransient(reopened.schematic)),
      deck,
      'Simulation follows native circuit content after changing the folder and filename.',
    );
    assert.deepEqual(modelCadFromProject(reopened), modelCadFromProject(project));
    for (const model of reopened.simulationModels ?? []) {
      assert.deepEqual(
        await readProjectModelFile(destination, model),
        await readProjectModelFile(originalPath, model),
        'Pinned model bytes are read beside the copied native project without a download.',
      );
    }

    const core = new ProjectCore(reopened);
    for (const sheet of [reopened.schematic, ...(reopened.additionalSchematics ?? [])]) {
      const erc = (await core.query('schematic.erc', {
        schematicId: sheet.id,
      })) as RuleCheckResult;
      assert.equal(erc.complete, true);
      assert.deepEqual(erc.issues, []);
    }
    const before = core.query('source.files');
    const settingsFile = reopenedFiles.files.find((file: { name: string }) =>
      file.name.endsWith('.kicad_pro'),
    )!;
    const settings = JSON.parse(settingsFile.source);
    settings.text_variables = { ...settings.text_variables, CUSTOMER_REVISION: 'B' };
    core.execute('source.updateFile', {
      name: settingsFile.name,
      source: JSON.stringify(settings, null, 2) + '\n',
    });
    core.execute('source.apply');
    assert.equal(core.getSnapshot().undoDepth, 1);
    assert.deepEqual(
      buildSpiceDeck(core.getSnapshot().project!.schematic, defaultTransient(reopened.schematic)),
      deck,
    );
    assert.equal(core.execute('history.undo'), true);
    assert.deepEqual(core.query('source.files'), before);

    const board = reopened.pcb!;
    const controllerId = reopened.schematic.parts.find((part) => part.ref === 'U1')!.id;
    const heater = board.footprints.find((footprint) => footprint.symbolId === controllerId)!;
    assert.ok(heater, 'The native board retains its controller footprint.');
    const thermal = {
      ...defaultThermalConfig(board),
      heatSources: [{ footprintId: heater.id, powerW: 1 }],
    };
    if (entry.file === 'tps61046-bga6-boost') {
      for (const candidate of [project.pcb!, board]) {
        const vin = candidate.nets.find((net) => net.name === '/VIN');
        const zone = candidate.zones.find((item) => item.netId === vin?.id);
        assert.ok(zone?.fillEnabled);
        assert.equal(zone.filledPolygons, undefined, 'Save as preserves the absent KiCad fill.');
        assert.throws(() => prepareThermalModel(candidate, thermal), /Fill copper zones/);
      }
    } else {
      assert.deepEqual(
        prepareThermalModel(board, thermal),
        prepareThermalModel(project.pcb!, thermal),
        'Thermal geometry follows the native board; 1 W is an explicit test input, not inferred loss.',
      );
    }
    assert.deepEqual(
      await readNativeProject(originalPath),
      native,
      'Checks never edit the source.',
    );
  });
}

for (const entry of homeExampleCatalog.filter((item) => item.id.startsWith('reference-'))) {
  test(`${entry.file}: a project-local controller symbol uses its exact reviewed model binding`, async () => {
    const project = projectFromNativeFiles(
      await readNativeProject(path.resolve(homeExampleNativePath(entry.id))),
    );
    const circuit = project.schematic;
    const expected = buildSpiceDeck(circuit, defaultTransient(circuit));
    const controller = circuit.parts.find((part) => part.ref === 'U1')!;
    const localId = 'Customer:Controller';
    const native = projectNativeFiles(project);
    for (const file of native.files)
      if (file.name.endsWith('.kicad_sch'))
        file.source = file.source.replaceAll(quote(controller.libId), quote(localId));
    const reopened = projectFromNativeFiles(native).schematic;
    assert.equal(simulationSupportError(reopened), '');
    assert.deepEqual(buildSpiceDeck(reopened, defaultTransient(reopened)), expected);
    assert.deepEqual(serviceDeck(reopened, defaultTransient(reopened)), expected);

    for (const [field, value] of [
      ['Sim.Name', 'CUSTOM_UNREVIEWED_MODEL'],
      ['Sim.Library', 'models/custom.lib'],
      ['Sim.Pins', '1=2 2=1'],
    ]) {
      const invalid = structuredClone(reopened);
      const part = invalid.parts.find((candidate) => candidate.ref === 'U1')!;
      part.fields = { ...partFields(part), [field]: value };
      assert.throws(() => buildSpiceDeck(invalid, defaultTransient(invalid)), field);
    }
    const invalidPins = structuredClone(reopened);
    const pin = children(invalidPins.libraries[localId], 'symbol').flatMap((symbol) =>
      children(symbol, 'pin'),
    )[0];
    assert.ok(pin);
    child(pin, 'at')![1] = '999';
    assert.throws(() => buildSpiceDeck(invalidPins, defaultTransient(invalidPins)));
  });

  test(`${entry.file}: controller reference changes do not require Home identity`, async () => {
    const project = projectFromNativeFiles(
      await readNativeProject(path.resolve(homeExampleNativePath(entry.id))),
    );
    const core = new ProjectCore(project);
    const controller = project.schematic.parts.find((part) => part.ref === 'U1')!;
    const before = core.getSnapshot().source;
    core.execute('part.properties', {
      schematicId: project.schematic.id,
      partId: controller.id,
      reference: 'U42',
    });
    const edited = core.getSnapshot().project!.schematic;
    assert.equal(edited.parts.find((part) => part.id === controller.id)!.ref, 'U42');
    assert.equal(simulationSupportError(edited), '');
    assert.deepEqual(
      buildSpiceDeck(edited, defaultTransient(edited)),
      serviceDeck(edited, defaultTransient(edited)),
    );
    assert.equal(core.execute('history.undo'), true);
    assert.equal(core.getSnapshot().source, before);
  });
}
