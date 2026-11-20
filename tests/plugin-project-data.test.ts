import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginProjectDirectory, isPluginProjectData } from '../plugins/runtime/project-data.mjs';
import { isAgentRestrictedFile } from '../lib/agent-file-policy';

test('project data uses the package directory and qualified local IDs without publisher collisions', () => {
  assert.equal(pluginProjectDirectory('spice-simulation@openpe'), 'spice-simulation');
  assert.equal(pluginProjectDirectory('pcb-thermal@openpe'), 'layout-thermal');
  assert.equal(pluginProjectDirectory('ai-pcb-layout@openpe'), 'pe-layout-skill');
  assert.equal(pluginProjectDirectory('layout-parasitics@openpe'), 'layout-parasitics');
  assert.equal(pluginProjectDirectory('summary@alice'), 'summary@alice');
  assert.equal(pluginProjectDirectory('summary@bob'), 'summary@bob');
  for (const id of ['../outside', 'folder/file@publisher', '', 'summary'])
    assert.throws(() => pluginProjectDirectory(id), /identity/);
});

test('portable models remain native while plugin results and metadata stay outside native data and Agent file access', () => {
  for (const file of ['models/vendor.lib', 'models/nested/vendor.cir']) {
    assert.equal(isPluginProjectData(file), false, file);
    assert.equal(isAgentRestrictedFile(file), true, file);
  }
  for (const file of [
    'spice-simulation/board.circuit.cir',
    'spice-simulation/models/obsolete.lib',
    'layout-thermal/board.input.json',
    'pe-layout-skill/state.json',
    'layout-parasitics/measurements.json',
    'summary@alice/state.json',
  ]) {
    assert.equal(isPluginProjectData(file), true, file);
    assert.equal(isAgentRestrictedFile(file), true, file);
  }
  assert.equal(isPluginProjectData('symbols/custom.kicad_sym'), false);
  assert.equal(isAgentRestrictedFile('notes.txt'), false);
});
