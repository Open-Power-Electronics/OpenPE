import catalog from '../resources/example-catalog/ic-datasheets.json';
import type { Project } from './project';
import { partFootprint } from './library';
import { child, val } from './sexpr';

export type ICDatasheetRecord = {
  $schema: string;
  schema_version: string;
  example: { id: string; file: string; title: string; topology: string };
  ic: {
    manufacturer: string;
    family: string;
    reference: string;
    schematic_value: string;
    symbol_library_id: string;
    footprint: string;
    package: string;
    datasheet_variant: string;
  };
  datasheet: {
    title: string;
    document_number: string;
    revision: string | null;
    published_month: string;
    product_url: string;
    source_url: string;
    filename: string;
    sha256: string;
    bytes: number;
    page_count: number;
    downloaded_on: string;
  };
  extraction: { method: string; reviewed_on: string; scope: string; notes: string[] };
  parameters: Record<
    string,
    {
      category: string;
      unit: string;
      values: { min: number | null; typ: number | null; max: number | null };
      conditions: string;
      source: { page: number; section: string; row: string };
      notes?: string;
    }
  >;
};

export type ProjectDatasheetContext = {
  version: 1;
  projectId: string | null;
  exampleId: string | null;
  status: 'available' | 'not-example' | 'controller-mismatch';
  basis: 'validated-project';
  bindings: { schematicId: string; partId: string; reference: string }[];
  record: ICDatasheetRecord | null;
};

// Imported lazily by the workbench; build-format validates these exact records.
// There is no filesystem, URL resolver, model compiler or editable data owner here.
// JSON array inference adds optional undefined keys across differing parameter
// maps; build-format validates every record against the exact record schema.
const records = catalog as unknown as readonly ICDatasheetRecord[];

export function projectDatasheetContext(project: Project | null): ProjectDatasheetContext {
  const identity = (part: NonNullable<Project['schematic']['parts']>[number]) =>
    (part.raw && val(child(part.raw, 'lib_id'))) || part.libId;
  const candidates = records.filter((item) =>
    project?.schematic.parts.some((part) => identity(part) === item.ic.symbol_library_id),
  );
  const matching = candidates.filter((item) =>
    project?.schematic.parts.some(
      (part) =>
        identity(part) === item.ic.symbol_library_id &&
        part.value === item.ic.schematic_value &&
        partFootprint(part) === item.ic.footprint,
    ),
  );
  // A singular record cannot represent multiple different controllers. Native
  // identity, rather than private example provenance, selects reviewed evidence.
  const record =
    matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : null;
  const bindings =
    record && project
      ? project.schematic.parts
          .filter(
            (part) =>
              part.value === record.ic.schematic_value &&
              identity(part) === record.ic.symbol_library_id &&
              partFootprint(part) === record.ic.footprint,
          )
          .map((part) => ({
            schematicId: project.schematic.id,
            partId: part.id,
            reference: part.ref,
          }))
      : [];
  return {
    version: 1,
    projectId: project?.id ?? null,
    exampleId: record?.example.id ?? null,
    status: !record ? 'not-example' : bindings.length ? 'available' : 'controller-mismatch',
    basis: 'validated-project',
    bindings,
    // Return independent wrappers; callers cannot mutate the bundled catalog.
    record: record && bindings.length ? structuredClone(record) : null,
  };
}
