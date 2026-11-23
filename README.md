# OpenPE

**AI-native workbench for the power electronics engineer.**

OpenPE · Electrical Engineering Studio is an open-source desktop app for power-electronics design. The Agent conversation sits on the left. Schematic, PCB layout, Model and native KiCad source sit on the right.

![OpenPE with the EMC Flyback layout open and transformer T1 selected](assets/readme/workspace.webp)

Native KiCad 10 files, with bundled OpenCASCADE, ngspice, Gmsh and Elmer. Manual editing and supported simulation work without an Agent. Visit the [website](https://open-power-electronics.github.io/).

## Design alongside your Agent

- **Session and Agent.** Switch conversations, discuss the open project and request edits.
- **Design workspace.** Open Schematic, Layout, Model or Source, and edit the selection in Properties.
- **Native project.** Save a portable KiCad project with its supporting assets. Recover design drafts and compare local Git history.

Start from a curated example or your own circuit.

## From schematic to model

One native project carries the schematic, the board and Model CAD solids.

- **Schematic.** Edit the circuit, draw custom symbols and run a supported ngspice transient.
- **Layout.** Place and route the PCB manually, draw custom footprints and inspect the board in 3D. Bounded ERC and DRC stay read-only checks.
- **Model.** Create bounded CAD solids and export enclosure STEP.

Edit directly, or ask a scoped Agent.

## Work with your local Agent

Connect an Agent you already run locally. It works on the open project, within the access its mode allows.

Codex, Claude Code and Cursor use scoped tools on the current schematic, PCB layout, Model CAD and supported simulation. DeepSeek Harness and Pi stay on context and proposals. [Raw KiCad mode](DESIGN.md#settings-and-appearance) pauses the workbench and sends selected native files from a chat-only view.

Projects stay on disk as native KiCad files. The provider you choose receives the prompts and context you send.

## Extend the workbench

Five plugins ship built in:

- **SPICE Simulation.** Run a supported transient from the schematic.
- **Layout Thermal.** Estimate steady PCB temperature with Gmsh and Elmer, under the documented board model.
- **Layout Parasitics.** Measure two-terminal DC resistance and shortest-path partial inductance.
- **EMC Analysis.** Declare PCB intent, inspect geometric findings, locate affected objects and record manual reviews, justified exceptions and reports. A design review, not a compliance test. See [EMC Analysis](docs/EMC.md).
- **PE Layout Skill.** Bundled guidance for power-electronics PCB design and review.

Install a local JavaScript plugin with declared inputs and optional project read access. See the [plugin SDK](docs/PLUGINS.md#plugin-packages-and-sdk).

## Get OpenPE

The v0.1.0 Beta publishes unsigned installers for **Windows x64** and **macOS arm64** on [Releases](https://github.com/Open-Power-Electronics/OpenPE/releases). **Linux x64** is not yet published as an installer or solver download. Linux users [run from source](docs/DEVELOPMENT.md#run-from-source) and build solvers locally with the [Linux solver build steps](docs/DEVELOPMENT.md#maintainer-solver-builds). See the [installation guide](docs/DEVELOPMENT.md#install-the-app) for host requirements.

Use Node.js 24 and Git to [run from source](docs/DEVELOPMENT.md#run-from-source). The development guide also covers browser mode, offline solver preparation, checks and packaging.

## Learn more

[Documentation](docs/README.md) · [Examples](docs/EXAMPLES.md) · [Architecture](docs/ARCHITECTURE.md) · [Coverage and limits](docs/README.md#coverage-and-limits) · [Contributing](CONTRIBUTING.md)

## License

[Apache-2.0](LICENSE). Third-party assets retain their licenses and attribution.
