import lm2596 from '../examples/lm2596-to220-5-buck/datasheets/parameters.json';
import tps61046 from '../examples/tps61046-bga6-boost/datasheets/parameters.json';
import lm2735 from '../examples/lm2735-msop8-sepic/datasheets/parameters.json';
import lm25017 from '../examples/lm25017-wson8-flybuck/datasheets/parameters.json';
import lm5001 from '../examples/lm5001-soic8-boost/datasheets/parameters.json';
import lm27761 from '../examples/lm27761-wson8-pump/datasheets/parameters.json';
import lmr12010 from '../examples/lmr12010-sot236-buck/datasheets/parameters.json';
import lmr70503 from '../examples/lmr70503-bga8-buckboost/datasheets/parameters.json';
import lm2598 from '../examples/lm2598-to220-7-buck/datasheets/parameters.json';
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
const records: readonly ICDatasheetRecord[] = [
  lm2596,
  tps61046,
  lm2735,
  lm25017,
  lm5001,
  lm27761,
  lmr12010,
  lmr70503,
  lm2598,
];

export function projectDatasheetContext(project: Project | null): ProjectDatasheetContext {
  const provenance = project?.extensions['org.openpe.reference-example'] as
    { id?: unknown } | undefined;
  const record = records.find((item) => item.example.id === provenance?.id);
  const bindings =
    record && project
      ? project.schematic.parts
          .filter(
            (part) =>
              part.value === record.ic.schematic_value &&
              ((part.raw && val(child(part.raw, 'lib_id'))) || part.libId) ===
                record.ic.symbol_library_id &&
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
