import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box } from 'lucide-react';
import PartIdentity from '../../components/PartIdentity';
import PartProperties from '../../components/PartProperties';
import FieldProperties from '../../components/FieldProperties';
import { NumberField, PropertySelect } from '../../components/LayoutPropertyFields';
import LayoutProperties from '../../components/LayoutProperties';
import ModelCadPanel from '../../components/ModelCadPanel';
import ComponentProperties from '../../components/ComponentProperties';
import PropertiesEmptyState from '../../components/PropertiesEmptyState';
import { parseProject } from '../../lib/project';
import {
  newModelCadObject,
  newModelCadBooleanObject,
  validateModelCadObject,
} from '../../lib/model-cad';

const project = parseProject(window.propertiesProject);
const board = project.pcb;
const footprint = board.footprints.find((item) => item.symbolId && item.pads.length);
const mechanical = board.footprints.find((item) => !item.symbolId);
const part = project.schematic.parts.find((item) => item.id === footprint.symbolId);
const box = newModelCadObject(board, 'box');
const cylinder = newModelCadObject(board, 'cylinder');
const extrusion = validateModelCadObject({
  ...newModelCadObject(board, 'extrusion'),
  profile: {
    kind: 'polygon',
    points: [
      { x: -10, y: -10 },
      { x: 10, y: -10 },
      { x: 10, y: 10 },
      { x: -10, y: 10 },
    ],
  },
});
const boolean = newModelCadBooleanObject(box, newModelCadObject(board, 'cylinder'), 'union');
const pad = { ...footprint.pads[0], shape: 'roundrect', roundrectRatio: 0.25 };
const through = {
  ...pad,
  type: 'thru_hole',
  shape: 'circle',
  size: { x: 1.8, y: 1.8 },
  drill: 0.8,
};
const hole = { ...through, type: 'np_thru_hole', number: '', netId: null };
const zone = {
  id: 'audit-zone',
  layer: 'F.Cu',
  netId: board.nets[0].id,
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
  outline: [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ],
};
const line = {
  id: 'audit-graphic',
  kind: 'line',
  layer: 'F.SilkS',
  width: 0.15,
  start: { x: 0, y: 0 },
  end: { x: 20, y: 10 },
};
const text = {
  ...line,
  kind: 'text',
  text: { value: 'Output', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.15 },
};
const dimension = {
  ...line,
  kind: 'dimension',
  layer: 'Dwgs.User',
  dimension: {
    type: 'aligned',
    height: 5,
    caption: { value: '20 mm', x: 10, y: 5, rotation: 0, size: { x: 1, y: 1 }, thickness: 0.15 },
    format: { prefix: '', suffix: '', units: 2, precision: 2 },
    style: { arrowLength: 1, extensionOffset: 0.5, textPositionMode: 0 },
  },
};
const choices = [
  'pad',
  'through-pad',
  'hole',
  'track',
  'locked-track',
  'via',
  'footprint',
  'mechanical',
  'line',
  'arc',
  'circle',
  'polygon',
  'text',
  'dimension',
  'zone',
  'rule-area',
  'outline',
  'selection',
  'empty',
  'field',
  'label',
  'wire',
  'cylinder',
  'extrusion',
  'boolean',
  'board',
];
window.propertiesChoices = choices;
window.inspectorSaves = 0;
window.solidApplies = 0;
window.draft = null;

function Fixture() {
  const [choice, setChoice] = useState('pad');
  const [width, setWidth] = useState(280);
  const [visible, setVisible] = useState(true);
  const selectedPad =
    choice === 'pad'
      ? pad
      : choice === 'through-pad'
        ? through
        : choice === 'hole'
          ? hole
          : undefined;
  const selectedFootprint =
    choice === 'footprint' ? footprint : choice === 'mechanical' ? mechanical : undefined;
  const selectedTrack =
    choice === 'track'
      ? board.tracks[0]
      : choice === 'locked-track'
        ? { ...board.tracks[0], locked: true }
        : undefined;
  const currentBoard =
    choice === 'locked-track'
      ? { ...board, tracks: [selectedTrack, ...board.tracks.slice(1)] }
      : board;
  const graphic =
    choice === 'text'
      ? text
      : choice === 'dimension'
        ? dimension
        : choice === 'line'
          ? line
          : choice === 'arc'
            ? { ...line, kind: 'arc', mid: { x: 5, y: 12 } }
            : choice === 'circle'
              ? { ...line, kind: 'circle' }
              : choice === 'polygon'
                ? {
                    ...line,
                    kind: 'polygon',
                    points: [
                      { x: 20, y: 0 },
                      { x: 20, y: 10 },
                    ],
                  }
                : undefined;
  const selectedZone =
    choice === 'zone'
      ? zone
      : choice === 'rule-area'
        ? {
            ...zone,
            keepout: {
              tracks: true,
              vias: true,
              pads: false,
              copperpour: false,
              footprints: false,
            },
          }
        : undefined;
  const selectionCount = choice === 'empty' ? 0 : choice === 'selection' ? 3 : 1;
  const solid =
    choice === 'cylinder'
      ? cylinder
      : choice === 'extrusion'
        ? extrusion
        : choice === 'boolean'
          ? boolean
          : box;
  return (
    <>
      <nav>
        {choices.map((name) => (
          <button key={name} onClick={() => setChoice(name)}>
            {name}
          </button>
        ))}
        <button onClick={() => setWidth(width === 280 ? 480 : 280)}>Resize</button>
        <button onClick={() => setVisible(!visible)}>Toggle model</button>
      </nav>
      <main style={{ '--inspector-width': `${width}px` }}>
        <section className="column">
          <header>Schematic</header>
          <div className="inspector part-inspector">
            <div className="inspector-body">
              {choice === 'empty' ? (
                <PropertiesEmptyState icon={Box}>
                  Select an element to view its properties.
                </PropertiesEmptyState>
              ) : choice === 'field' ? (
                <FieldProperties
                  field="Reference"
                  text={part.ref}
                  position={{ x: 1.27, y: 2.54 }}
                  onText={() => true}
                  onPosition={() => true}
                />
              ) : choice === 'label' ? (
                <div className="layout-property-section">
                  <label className="layout-field">
                    Net name
                    <input aria-label="Net name" defaultValue="OUTPUT" />
                  </label>
                  <PropertySelect
                    label="Global label shape"
                    displayLabel="Shape"
                    value="input"
                    options={[{ value: 'input', label: 'Input' }]}
                    onChange={() => {}}
                  />
                </div>
              ) : choice === 'wire' ? (
                <div className="wire-properties layout-property-section">
                  <strong>Wire</strong>
                  <div className="layout-property-readout">
                    <span>Length</span>
                    <output>12.7 mm</output>
                  </div>
                </div>
              ) : (
                <>
                  <PartIdentity part={part} library={project.schematic.libraries[part.libId]} />
                  <PartProperties
                    part={part}
                    circuit={project.schematic}
                    spiceAvailable
                    active
                    geometryFields={
                      <div className="geometry-fields component-geometry">
                        {['x', 'y', 'rotation'].map((key) => (
                          <NumberField
                            key={key}
                            label={
                              key === 'rotation' ? 'Rotation (°)' : `${key.toUpperCase()} (mm)`
                            }
                            accessibleLabel={
                              key === 'rotation'
                                ? 'Component rotation'
                                : `Component ${key.toUpperCase()} position`
                            }
                            value={part[key]}
                            onCommit={() => true}
                          />
                        ))}
                      </div>
                    }
                    onSave={() => {
                      window.inspectorSaves++;
                      return true;
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </section>
        <section className="column">
          <header>Layout</header>
          <div className="layout-inspector">
            <div className="layout-inspector-content">
              <LayoutProperties
                key={choice}
                board={currentBoard}
                schematic={project.schematic}
                active
                resetKey
                snap={(value) => value}
                pad={selectedPad}
                padOwner={selectedPad ? footprint : undefined}
                footprint={selectedFootprint}
                track={selectedTrack}
                via={choice === 'via' ? board.vias[0] : undefined}
                zone={selectedZone}
                graphic={graphic}
                rectangle={
                  choice === 'outline'
                    ? {
                        ids: [board.graphics[0].id],
                        bounds: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
                      }
                    : null
                }
                selectionCount={selectionCount}
                lockTargets={
                  selectedTrack
                    ? [{ kind: 'track', id: selectedTrack.id }]
                    : choice === 'selection'
                      ? [{ kind: 'footprint', id: footprint.id }]
                      : []
                }
                onLock={() => {}}
                onCommit={() => true}
                onFootprint={() => true}
                onTrack={() => true}
                onZone={() => true}
                onRectangle={() => true}
                onError={(error) => {
                  throw Error(error);
                }}
                onInspectFootprint={() => {}}
                onSavePartProperties={() => true}
              />
            </div>
          </div>
        </section>
        <section className="column model-column">
          <header>Model</header>
          {selectedFootprint ? (
            <div className="model-properties-content">
              <div className="model-properties-body">
                <ComponentProperties
                  footprint={selectedFootprint}
                  schematic={project.schematic}
                  active
                  resetKey
                  snap={(value) => value}
                  onFootprint={() => true}
                  onSavePartProperties={() => true}
                />
              </div>
            </div>
          ) : choice === 'board' || choice === 'empty' ? (
            <div className="model-properties-content">
              <div className="model-properties-body">
                {choice === 'board' ? (
                  <NumberField
                    label="Board thickness (mm)"
                    value={board.thickness}
                    onCommit={() => true}
                  />
                ) : (
                  <PropertiesEmptyState icon={Box}>
                    Select an element to view its properties.
                  </PropertiesEmptyState>
                )}
              </div>
            </div>
          ) : (
            <ModelCadPanel
              key={solid.id}
              object={solid}
              mode="edit"
              visible={visible}
              docked
              disabled={false}
              revision="1"
              onClose={() => {}}
              onDraftChange={(draft) => {
                window.draft = draft;
              }}
              onApply={async () => {
                window.solidApplies++;
              }}
            />
          )}
        </section>
      </main>
    </>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
