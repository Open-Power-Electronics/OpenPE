# OpenPE

**OpenPE · Electrical Engineering Studio** is a local workbench for power electronics, with Agent conversations on the left and editable designs on the right.

![OpenPE Home with the Signal E logo](assets/home.png)

## What you can do

- Edit native KiCad schematics and Source, manually place and route PCBs, and run ERC/DRC.
- Draw custom single-unit component symbols and embedded footprints through shared GUI/Agent commands.
- Inspect boards in 3D and create Model CAD solids with sketch contour Booleans, extrusion, fillets, chamfers and solid Boolean operations.
- Run supported SPICE transients and steady PCB thermal analysis.
- Estimate two-terminal PCB DC resistance and shortest-route partial inductance from routed copper. [Layout Parasitics](docs/LAYOUT.md#layout-parasitics)
- Keep independent projects and conversations, recover drafts and compare local Git history.
- Work with Codex or Claude Code through scoped project tools, or review proposals from DeepSeek Harness and Pi. Cursor supports CLI detection only.

Start with nine curated projects under Example. Recent opens EMC Flyback until you build your own opening and saving history. Right-click a Recent card to remove its listing while keeping its files. Use **Save as** to create a personal copy with supporting assets. The bundled PE Layout Skill plugin provides design guidance and board review. [Examples](docs/EXAMPLES.md) · [PE Layout Skill](docs/PLUGINS.md#pe-layout-skill)

## Get started

Requires **Windows x64**, **Node.js 24** and npm. Install Git for version history. Agent CLIs are configured separately; manual editing and simulation work without an Agent.

```sh
npm ci
npm run libraries:download
npm run build
npm start
```

Setup and build may download required libraries and solver resources. If dependencies were installed with `--ignore-scripts`, run `npm run postinstall` before starting Electron.

## Development

```sh
npm run dev                 # Desktop app with renderer hot reload
npm run dev -- --verbose    # Include full preparation and runtime logs
```

For browser UI development:

```sh
npm run examples:prepare
npm run dev:web
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000) while the server is running. Native file dialogs and Agent chat require Electron. Desktop development uses the same port, so run one development server at a time. Save your work and restart the app after changing Electron or service modules.

Browser development supports authenticated CAD previews and the [bundled plugins](docs/PLUGINS.md#bundled-workbench-lifecycle). Prepare missing CAD and thermal resources with `npm run thermal:prepare`, ngspice with `npm run simulation:prepare` and official KiCad component models with `npm run libraries:download-models`. See [browser preview boundaries](docs/ARCHITECTURE.md#browser-development-previews) for supported inputs and access limits.

| Command                    | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `npm run check:docs`       | Check documentation names, links and commands         |
| `npm run typecheck`        | Check architecture boundaries and TypeScript          |
| `npm test`                 | Run data/runtime tests and regenerate service formats |
| `npm run build:format`     | Generate schemas, validators and service bundles      |
| `npm run examples:prepare` | Verify Home projects and prepare portable assets      |
| `npm run build`            | Prepare resources and build the renderer              |
| `npm run package`          | Build the Windows app in `release/win-unpacked/`      |

See [verification](docs/ARCHITECTURE.md#verification) for focused tests and opt-in checks. [Engineering rules](AGENTS.md#verification-and-delivery) define required validation and authorization for desktop checks.

See [storage and build boundaries](docs/ARCHITECTURE.md#storage-and-build-boundaries) for test outputs, generation inputs, native projects and private application data.

## Scope

OpenPE supports a bounded subset of KiCad 10 and Model CAD. General CAD/model import, complete KiCad ERC/DRC parity, autorouting and manufacturing qualification are outside its scope. Save and Save as retain native `.kicad_pro`, `.kicad_sch` and `.kicad_pcb` file sets. File Export provides schematic and outline exchange, PCB fabrication and assembly output, and OpenSCAD for supported solids. Review CAM and assembly output before manufacturing. [Design exchange](docs/FORMAT.md#design-exchange) · [Manufacturing export](docs/FORMAT.md#manufacturing-export)

Simulation support depends on the documented circuits and models. Thermal analysis estimates PCB temperature under stated material and cooling assumptions, not package junction temperature or EMC emissions. See the feature documents below for coverage and limits.

## Documentation

| Topic               | Documents                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product and UI      | [Design](DESIGN.md) · [Layout and Model](docs/LAYOUT.md) · [ERC/DRC](docs/DESIGN-RULES.md)                                                                                |
| Files and history   | [Native format](docs/FORMAT.md) · [Version history](docs/VERSION-HISTORY.md)                                                                                              |
| Simulation          | [SPICE](docs/SIMULATION.md) · [Layout Thermal](docs/THERMAL.md) · [EMC Flyback](docs/EMC-FLYBACK.md)                                                                      |
| Examples and assets | [Examples](docs/EXAMPLES.md) · [Datasheets](docs/DATASHEETS.md) · [Libraries and licenses](docs/LIBRARIES.md)                                                             |
| Internals           | [Architecture](docs/ARCHITECTURE.md) · [Diagram](assets/architecture.drawio) · [Core](docs/CORE.md) · [API](docs/API.md) · [Plugin design specification](docs/PLUGINS.md) |
| Contributing        | [Engineering contract](AGENTS.md)                                                                                                                                         |

## License

[Apache-2.0](LICENSE). Third-party assets retain their licenses and attribution.
