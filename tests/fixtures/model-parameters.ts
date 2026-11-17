import { createReferenceExample } from '../../lib/reference-examples';
import { parseProject, serializeProject } from '../../lib/project';
import type { ProjectDocument } from '../../lib/project-document';

/** Exercise native parameter representations on a copy of the current Home Buck. */
export function parameterizedHomeProject(sourceType: 'DC' | 'PULSE' = 'DC') {
  const document: ProjectDocument = JSON.parse(
    serializeProject(createReferenceExample('reference-lm2598-to220-7-buck')),
  );
  const components = document.schematic.components;
  if (!components) throw new Error('The Home Buck fixture must contain its native components.');
  for (const [reference, device, value] of [
    ['R1', 'R', '5'],
    ['L1', 'L', '100u'],
  ] as const) {
    const part = components.find((part) => part.reference === reference)!;
    part.value = value;
    part.simulation = {
      device,
      type: '=',
      pins: '1=+ 2=-',
      modelSource: 'basic',
      valueFormat: `${device.toLowerCase()}=\${VALUE}`,
    };
    part.fieldLayout ??= {};
    part.fieldLayout['Sim.Params'] = [
      ['at', '0', '0', '0'],
      ['effects', ['font', ['size', '1.27', '1.27']], ['hide', 'yes']],
    ];
  }
  const source = components.find((part) => part.reference === 'V1')!;
  source.value = sourceType === 'DC' ? '24' : 'VPULSE';
  source.simulation = {
    device: 'V',
    type: sourceType,
    pins: '1=+ 2=-',
    ...(sourceType === 'PULSE'
      ? {
          sourceType,
          parameters: 'y1=0 y2=15 td=20n tr=20n tf=20n tw=25u per=50u',
        }
      : {}),
  };
  source.fieldLayout ??= {};
  if (sourceType === 'PULSE')
    source.fieldLayout['Sim.Params'] = [
      ['at', '40', '40', '0'],
      ['effects', ['font', ['size', '1.27', '1.27']]],
    ];
  else delete source.fieldLayout['Sim.Params'];
  return parseProject(JSON.stringify(document));
}
