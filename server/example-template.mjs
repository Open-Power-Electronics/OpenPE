import { parseProject, serializeProject } from './project-format.mjs';

const validatedSources = new WeakMap();
const maxSource = 8_000_000;

function freezeTemplate(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeTemplate(nested);
  Object.freeze(value);
}

/** Private host preparation; the receipt attests only the exact immutable text. */
export function createExampleTemplate(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maxSource)
    throw new Error('The project exceeds 8 MB.');
  const project = parseProject(source);
  const canonical = serializeProject(project);
  if (Buffer.byteLength(canonical) > maxSource) throw new Error('The project exceeds 8 MB.');
  freezeTemplate(project);
  const receipt = Object.freeze({});
  validatedSources.set(receipt, canonical);
  return Object.freeze({ project, source: canonical, receipt });
}

/** Forged/copied receipts and changed source always use ordinary validation. */
export function validatedExampleTemplateSource(receipt, source) {
  const canonical = validatedSources.get(receipt);
  return canonical === source ? canonical : undefined;
}
