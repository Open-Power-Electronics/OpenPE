import { circuitFingerprint, pinPositions, type Circuit } from './circuit';
import { partFields, symbolAnnotation } from './library';
import { schematicTexts } from './schematic-text';
import { selectedField } from './schematic-edit';
import {
  maxAnnotationElements,
  type AgentAnnotation,
  type AnnotationElement,
  type AnnotationMarkup,
  validateAnnotationMarkup,
} from './agent-annotations';

export function captureAnnotationSelection(
  doc: Circuit,
  ids: string[],
  markup?: AnnotationMarkup,
): Omit<AgentAnnotation, 'image' | 'comment'> {
  if (markup) validateAnnotationMarkup(markup);
  if (
    (!ids.length && !markup) ||
    new Set(ids).size !== ids.length ||
    ids.length > maxAnnotationElements
  )
    throw new Error(`Select between 1 and ${maxAnnotationElements} elements to annotate.`);
  const elements = ids.map((id): AnnotationElement => {
    const field = selectedField(id);
    const part = doc.parts.find((p) => p.id === (field?.id || id));
    if (part) {
      const properties: Record<string, string> = {
        Reference: part.ref,
        Value: part.value,
        Symbol: part.libId,
        Unit: String(part.unit || 1),
        'X (mm)': String(part.x),
        'Y (mm)': String(part.y),
        'Rotation (deg)': String(part.rotation),
        Mirror: part.mirror || 'none',
      };
      if (field) {
        properties.Field = field.field;
        properties.Position = JSON.stringify(
          symbolAnnotation(part, doc.libraries[part.libId], field.field),
        );
        properties['Component ID'] = part.id;
      } else {
        properties.Fields = JSON.stringify(partFields(part));
        properties['Pin positions (mm)'] = JSON.stringify(
          pinPositions(part, doc.libraries[part.libId]),
        );
      }
      return {
        id,
        kind: field ? 'field' : 'component',
        label: field ? `${part.ref} · ${field.field}` : part.ref,
        properties,
      };
    }
    const wire = doc.wires.find((w) => w.id === id);
    if (wire)
      return {
        id,
        kind: 'wire',
        label: 'Wire',
        properties: { 'Start (mm)': JSON.stringify(wire.a), 'End (mm)': JSON.stringify(wire.b) },
      };
    const label = doc.labels.find((l) => l.id === id);
    if (label)
      return {
        id,
        kind: 'label',
        label: label.text,
        properties: {
          Text: label.text,
          Scope: label.scope || 'local',
          'X (mm)': String(label.x),
          'Y (mm)': String(label.y),
          'Rotation (deg)': String(label.rotation || 0),
          Shape: label.shape || '',
        },
      };
    const note = schematicTexts(doc.original).find((t) => t.id === id);
    if (note)
      return {
        id,
        kind: 'text',
        label: 'Schematic text',
        properties: {
          Text: note.text,
          'X (mm)': String(note.x),
          'Y (mm)': String(note.y),
          'Size (mm)': String(note.size),
        },
      };
    const junction = doc.junctions.find((p) => p.id === id);
    const point = junction || doc.noConnects?.find((p) => p.id === id);
    if (point)
      return {
        id,
        kind: junction ? 'junction' : 'no-connect',
        label: junction ? 'Junction' : 'No-connect',
        properties: { 'X (mm)': String(point.x), 'Y (mm)': String(point.y) },
      };
    throw new Error('A selected element no longer exists. Select the elements again.');
  });
  return {
    id: crypto.randomUUID(),
    circuitId: doc.id,
    title: doc.title,
    basis: circuitFingerprint(doc),
    elements,
    ...(markup ? { markup: structuredClone(markup) } : {}),
  };
}
