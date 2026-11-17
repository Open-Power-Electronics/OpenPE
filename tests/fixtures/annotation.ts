import { emptyCircuit, createPart } from '../../lib/circuit';
import { captureAnnotationSelection } from '../../lib/annotation-selection';
import type { AgentAnnotation } from '../../lib/agent-annotations';
export function annotationFixture(): AgentAnnotation {
  const doc = emptyCircuit();
  doc.title = 'Fixture';
  doc.parts.push(createPart(doc, 'R', 25.4, 25.4));
  return {
    ...captureAnnotationSelection(doc, [doc.parts[0].id]),
    comment: 'Check the resistor',
    image: {
      width: 1,
      height: 1,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
    },
  };
}
