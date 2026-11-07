# Example IC datasheets and parameter records

This collection covers the main controller (`U1`) in all ten Home projects: the nine curated Example entries and EMC Flyback in Recent,
listed in [the Home catalog](../resources/example-catalog/home-manifest.json).
Reviewed parameters are bundled in the internal
[reference catalog](../resources/example-catalog/ic-datasheets.json). OpenPE does
not generate a separate datasheet JSON in project directories. An original vendor
PDF can be downloaded separately. The JSON records retain the canonical schematic value, symbol library ID,
Footprint assignment and catalog identity, including the selected adjustable,
X or Y variant.

Source displays any original PDF present in the example directory. Packaging includes those existing files.
The Agent uses a separate bundled, reviewed host record bound to the current
controller. That record is independent of editable disk text, native KiCad
documents, Core state, undo, recovery and simulation models. The schematics,
boards and pinned upstream sources remain the sources of design data.

## Source and Agent access

In Source, expand the actual `datasheets` directory. Local PDFs open in an iframe from bounded
grant-read Blob bytes, up to 32 MiB. These files stay outside native Core,
document undo, recovery and automatic Agent context. Native file drafts and
editor history survive these visits. The Core `source.files` query continues
to contain only native project text. User-authored files do not replace the Agent's reviewed host record.

The host query `project.datasheet` takes `{}` and returns `version: 1`,
`projectId`, `exampleId`, `basis: 'validated-project'`, `status`, `bindings` and
`record`. Submission context and `workbench.state` include the same result as
`icDatasheet`, giving both live-tool and context-only Agents the parameters,
conditions, official URLs, revision/hash and one-based PDF page locators.

Selection uses the actual controller value, native symbol identity and Footprint
assignment on the primary schematic, including ordinary imported and renamed
projects without private example provenance. `exampleId` identifies the reviewed
catalog record, not the origin or identity of the user's design. Binding
entries identify its current schematic ID, part ID and reference; a renamed or
copied matching controller retains an explicit binding. Filename/title guesses,
absent controllers and unrelated secondary-sheet lookalikes do not select data.
Multiple different matching controller records are ambiguous and expose no singular record.
`available` includes the reviewed record; `not-example` and
`controller-mismatch` return `record: null`. The Agent observation reports that
status; Source continues to show the actual disk files. Pending native Source
does not replace the validated IC identity.

The renderer lazy-loads reference data on project activation or an explicit
context/query read; Home initially loads no parameter records. Context loading
rechecks project revision, active sheet and project activation before dispatch. Closing or suspended
hosts cancel reads. The service validates submitted reference observations
against the same bundled records and project bindings, rejecting altered values,
source URLs or another project's bindings. `build:format` checks record schema
and catalog/controller identity before generating the service context bundle.
No runtime schema compilation or PDF download is required.

## Coverage

| Example file stem         | Selected controller    | Vendor document                 | Parameters |
| ------------------------- | ---------------------- | ------------------------------- | ---------- |
| `lm2596-to220-5-buck`     | LM2596T-ADJ            | SNVS124G, revision G            | 13         |
| `tps61046-bga6-boost`     | TPS61046               | SLVSCQ7, initial issue          | 15         |
| `lm2735-msop8-sepic`      | LM2735Y, MSOP-PowerPAD | SNVS485I, revision I            | 16         |
| `lm25017-wson8-flybuck`   | LM25017, WSON          | SNVS951F, revision F            | 15         |
| `lm5001-soic8-boost`      | LM5001, SOIC           | SNVS484H, revision H            | 15         |
| `lm27761-wson8-pump`      | LM27761, WSON          | SNVSA85D, revision D            | 16         |
| `lmr12010-sot236-buck`    | LMR12010X              | SNVS731B, revision B            | 15         |
| `lmr70503-bga8-buckboost` | LMR70503               | SNVS850A, revision A            | 14         |
| `lm2598-to220-7-buck`     | LM2598_ADJ             | SNVS125D, revision D            | 13         |
| `emc-flyback`             | UC3845B, SO8           | ST UC3842B/3B/4B/5B, March 1999 | 13         |

The 145 entries cover input/output limits, current capabilities, feedback or
reference voltage, switching frequency, peak switch-current limits, supply and
shutdown currents, duty cycle, switch resistance, temperature limits and
device-specific timing or LDO characteristics where specified. Numeric
specifications absent from the reviewed datasheet are omitted. In particular,
boost switch-current limits are not output-current ratings, and the LM25017
buck-stage current capability is not an isolated-output current budget.

## Download and verify

EMC Flyback uses STMicroelectronics UC3845BD1013TR, not a TI controller.
Its ST family document has no printed revision letter or numbered document ID;
the record uses the printed family heading. Electrical table UVLO thresholds
(8.4 V / 7.6 V typical) differ from the first-page summary (8.5 V / 7.9 V).
The record uses table values. The 52 kHz oscillator test point is not the board
switching frequency: UC3845B blanks alternate output cycles. Its 30 V supply
limit is an absolute rating for controller VCC, not the flyback input bus.
No recommended supply or junction-temperature range is inferred.

Run from the repository root with the installed development dependencies:

```sh
npm run datasheets:download
npm run datasheets:check
node --import tsx --test tests/example-datasheets.test.ts
```

EMC Flyback also includes the three remaining IC PDFs, pinned in
[the supplemental file catalog](../resources/example-catalog/emc-ic-datasheet-files.json):

| Reference | Fitted IC   | Local PDF     | Source                                    |
| --------- | ----------- | ------------- | ----------------------------------------- |
| U2        | L78L12ACUTR | `l78l12.pdf`  | ST                                        |
| U3        | TL431AIDBZR | `tl431.pdf`   | TI                                        |
| U4        | LTV-817S    | `ltv817s.pdf` | Lite-On document, Hitech distributor copy |

The U4 copy is the original Lite-On DS-70-96-0016 revision O document;
the manufacturer server could not provide a valid certificate chain and the
LCSC schematic link returned HTML. This distributor URL is explicit pinned
evidence, not a runtime fallback. These three PDFs have file identity/hash
metadata only; they do not add reviewed Agent parameter records. Together
with U1 and the nine reference controllers, all 13 fitted ICs have local PDFs.

The download command uses the official TI/ST URLs and the explicit pinned
Hitech PDF URL recorded in the catalogs,
permits at most three redirects within the selected source's HTTPS literature origin, bounds
each response to the recorded byte count and checks the PDF signature and
SHA-256 before publishing a complete file. It reuses verified local PDFs and
preserves differing existing files. A vendor revision with changed bytes fails
verification and requires reviewing the updated PDF and parameters together.
The check command is offline and read-only; it requires all 13 local PDFs.

PDFs are named `<ic-family-in-lowercase>.pdf` under the matching circuit's
`datasheets/` directory: `examples/<stem>/datasheets/` for the nine Example projects
and `project/emc-flyback/datasheets/` for EMC Flyback. Original PDF bytes are ignored by Git; the internal reviewed catalog, schema
and [rights notice](../public/licenses/example-datasheets.txt) are retained. A fresh checkout must run the
download command for local PDFs. Normal builds and startup do not download
PDFs. Builds validate and bundle the internal Agent reference catalog; packaging
also includes the actual example directory and any existing PDFs. The unit regressions validate metadata and exercise the
downloader using synthetic responses without requiring vendor files or network.

`tests/project-directory.test.ts` covers grant-bound text, local PDF reads and
file writes. The datasheet unit and runtime tests cover reviewed-record identity,
the host query and submitted Agent context. Isolated UI checks use mocked
services and do not establish Electron or real Agent-provider evidence.

## JSON contract, version 1.0.0

[ic-datasheet.schema.json](../resources/example-catalog/ic-datasheet.schema.json) is the normative JSON Schema
(draft 2020-12). Each record declares it through `$schema`; `schema_version`
is fixed to `1.0.0`. Objects reject unknown fields. A new parameter ID or unit
requires an explicit schema change; incompatible meanings require a new version.

| Field        | Contract                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `example`    | Stable catalog ID, file stem, title and topology; checked against `resources/example-catalog/home-manifest.json`.                                                                                                                                                                                                                                                                   |
| `ic`         | Manufacturer, family, reference, actual canonical schematic value, symbol library ID, Footprint assignment, catalog package and selected datasheet variant. Checked against the generated canonical example fixture. Package labels are catalog names; `datasheet_variant` records the vendor's selected package terminology. No unverified full orderable part number is inferred. |
| `datasheet`  | Original title, document number including revision suffix (or printed family heading for the unnumbered ST issue), revision letter or `null` for an unlettered initial issue, publication/revision month (`YYYY-MM`), official URLs, safe PDF filename, SHA-256, bytes, PDF page count and download date (`YYYY-MM-DD`).                                                            |
| `extraction` | Review method, review date, main-controller scope and qualifications for interpreting the record. Text extraction is followed by visual electrical-table review.                                                                                                                                                                                                                    |
| `parameters` | Named quantities from the schema's fixed dictionary. Each quantity has a category, unit, values, conditions and source locator; optional notes explain device-specific qualifications.                                                                                                                                                                                              |

Each quantity uses this shape, illustrated by LM2735Y switching frequency:

```json
{
  "category": "electrical_characteristic",
  "unit": "Hz",
  "values": { "min": 360000, "typ": 520000, "max": 680000 },
  "conditions": "LM2735-Y, VIN = 5 V; typical at TJ = 25 degC, limits over TJ = -40 to 125 degC.",
  "source": {
    "page": 5,
    "section": "6.5 Electrical Characteristics",
    "row": "FSW, LM2735-Y"
  }
}
```

All three value keys are required. `null` means that statistic was not specified
for the extracted condition; it never means zero, infinity or an inferred bound.
At least one value must be numeric. Values are finite and ordered
`min <= typ <= max` for the statistics present. Negative output ranges retain
their signs and numerical order. `conditions` states temperature coverage and
the distinction between room-temperature typicals and full-temperature limits.
`source.page` is the **one-based PDF page index**, not a section number, and
must not exceed the pinned PDF page count. The section and row locate the
relevant table entry; a source pointer is not a full-text copy of that table.

Canonical units are `V`, `A`, `Hz`, `Ohm`, `s`, `degC`, `1` and `dB`.
Milli/micro/nano prefixes are converted into numeric values in those units.
`1` denotes a fraction: duty cycle `0.92` means 92%. Noise voltage uses `V`
with RMS and integration bandwidth explicitly stated in the condition/notes.
The schema fixes the permitted unit and category for each parameter ID.

Categories preserve the kind of specification:

- `recommended_operating_condition`: the stated functional operating envelope.
- `absolute_maximum_rating`: a stress limit, never a usable operating target.
- `electrical_characteristic`: the table's min/typ/max under its stated conditions.
- `feature`: a feature-summary capability or adjustment range, subject to the
  application and external-component constraints; not a guaranteed board result.

The checker additionally enforces calendar dates, identity and variant binding,
ordered limits, fractional duty cycles, source-page bounds and an oscillator or switching-frequency
specification. Schema validation and byte pinning preserve the reviewed record;
they do not establish electrical correctness, simulation equivalence or hardware
qualification. The records contain selected IC specifications, not example
operating points or a replacement for reading the complete datasheet.

To update a record, download the intended official revision separately, extract
and visually inspect the relevant pages, then update document identity, size,
hash, page count, review date, conditions and values together. Keep source
locators tied to those exact bytes and run the checks above. The download tool
does not automatically rewrite curated parameters or accept new vendor bytes.
