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

OpenPE runs on **Windows x64** and **macOS Apple silicon (arm64)**. Both platforms are required for every change. macOS arm64 can be tested in a local checkout. Windows x64 verification may be deferred and must be recorded as unverified. [Engineering contract](AGENTS.md#verification-and-delivery)

### Install the app

1. Open the project [Releases](https://github.com/fleaxiao/OpenPE/releases).
2. Download the installer for this computer: the Windows x64 NSIS installer (`OpenPE Setup 0.1.0.exe`) or the macOS arm64 disk image (`OpenPE-0.1.0-arm64.dmg`).
3. On Windows, run the installer. It is a one-click install.
4. On macOS, open the disk image and drag OpenPE to Applications. The build is unsigned and signing stays off. Gatekeeper can block the first launch. Control-click OpenPE, choose Open, and confirm, or allow it under System Settings, Privacy & Security.
5. Launch OpenPE. The app includes its solvers, libraries and examples. End users do not download ngspice, Gmsh, Elmer or manufacturer models separately.

### Set up a development checkout

Prerequisites:

1. Node.js 24, from [nvm](https://github.com/nvm-sh/nvm) (`nvm install 24` and `nvm use 24`) or the official installer at [nodejs.org](https://nodejs.org/).
2. Git, for version history.
3. On macOS, Xcode Command Line Tools (`xcode-select --install`). Ordinary setup does not compile ngspice, Elmer or OpenBLAS and does not need Homebrew.

Then:

1. `npm ci` installs the locked dependencies. If that install skipped scripts, run `npm run postinstall` before starting Electron.
2. `npm run libraries:download` fetches the pinned KiCad libraries and parser source into `resources/kicad/` and `resources/third-party-source/`.
3. `npm run examples:prepare` prepares Home projects and portable assets. It generates the two OpenPE analytical STEP bodies for EMC Flyback L2 and T1 and downloads the pinned WE-CMB derivative. It does not download Bourns or Würth catalog CAD. Generating a missing analytical body needs the bundled Gmsh from `npm run thermal:prepare`.
4. `npm run simulation:prepare` downloads and verifies the host ngspice bundle. On macOS this is the release archive `ngspice-47-darwin-arm64-1.tar.gz`. It prints `Bundled ngspice 47 (darwin-arm64)` when the file hashes and the console version match.
5. `npm run thermal:prepare` downloads and verifies Gmsh 4.15.2 and Elmer 26.1. On macOS this is `thermal-1-darwin-arm64-1.tar.gz`. It prints that the runtime hashes, source archives, notices and manifests are verified.
6. `npm run dev` starts the desktop app with renderer hot reload. `npm run dev -- --verbose` includes preparation logs. Run one development server at a time.
7. `npm run package` builds the installer for the current host, then fails if the packaged service cannot resolve its runtime modules. macOS writes `release/mac-arm64/OpenPE.app` and `release/OpenPE-0.1.0-arm64.dmg`. Windows writes `release/win-unpacked/` and `release/OpenPE Setup 0.1.0.exe`.

macOS `simulation:prepare` and `thermal:prepare` download `ngspice-47-darwin-arm64-1.tar.gz` and `thermal-1-darwin-arm64-1.tar.gz` from prereleases `solvers-ngspice-47-darwin-arm64-1` and `solvers-thermal-1-darwin-arm64-1`. Those prereleases are not the application Latest release. Anonymous GitHub download returns 404 while `fleaxiao/OpenPE` is private, and preparation then fails with `Missing GitHub release asset` and the asset name. Preparation does not read credentials and has no environment override. While the repository is private, a collaborator with their own `gh` login downloads the pinned archives and installs them with the explicit archive flag. The flag checks the same pinned SHA-256 and size, rejects a link, and does not download when it is set:

```sh
gh release download solvers-ngspice-47-darwin-arm64-1 --repo fleaxiao/OpenPE --dir .openpe/downloads
gh release download solvers-thermal-1-darwin-arm64-1 --repo fleaxiao/OpenPE --dir .openpe/downloads
npm run simulation:prepare -- --archive .openpe/downloads/ngspice-47-darwin-arm64-1.tar.gz
npm run thermal:prepare -- --archive .openpe/downloads/thermal-1-darwin-arm64-1.tar.gz
```

This collaborator step disappears once the repository is public, because anonymous download of those prereleases then succeeds. An already verified local bundle is reused and is not downloaded again. The maintainer rebuild, not an ordinary setup step, is:

```sh
npm run solvers:build-macos
npm run solvers:publish
```

`solvers:build-macos` is maintainer-only. It requires Apple clang 17.0.0, macOS SDK 26.2, CMake 4.4.5 and Homebrew GCC 16.2.0, then writes `release/solvers/ngspice-47-darwin-arm64-1.tar.gz` and `release/solvers/thermal-1-darwin-arm64-1.tar.gz`. `solvers:publish` creates those two prereleases with `gh release create --latest=false --prerelease` and uploads the archives. Do not run it without owner approval.

Agent CLIs are configured separately. Manual editing and simulation work without an Agent.

## Development

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
| `npm run package`          | Build the host installer: macOS DMG or Windows NSIS   |

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
