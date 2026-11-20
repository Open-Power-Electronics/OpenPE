# OpenPE

**Power electronics, from conversation to circuit.**

OpenPE · Electrical Engineering Studio places Agent conversations beside editable electrical designs in a local desktop workbench.

![OpenPE Home](assets/home.png)

## One workspace for your design

- **Design in native KiCad.** Edit schematics, place and route PCBs manually, work with Source, and run bounded ERC/DRC checks.
- **See it in 3D.** Inspect your board, draw custom symbols and footprints, and create Model CAD solids.
- **Explore circuit behaviour.** Run supported SPICE transients, estimate PCB temperature and measure two-terminal PCB parasitics.
- **Review EMC layout evidence.** Declare PCB intent, inspect geometric findings, locate affected objects and record manual reviews, justified exceptions and reports with [EMC Analysis](docs/EMC.md).
- **Work with an Agent.** Use scoped project tools with Codex, Claude Code or Cursor, or review proposals from DeepSeek Harness and Pi. [Raw KiCad mode](DESIGN.md#settings-and-appearance) pauses the workbench and sends selected native files directly from a chat-only view.
- **Extend the workbench.** Install local JavaScript plugins with declared inputs and optional project read access. See the [plugin SDK](docs/PLUGINS.md#plugin-packages-and-sdk).
- **Keep your work local.** Manage independent projects and conversations, recover design drafts and compare local Git history.

Start with a curated example or your own circuit. Save a portable KiCad project with its supporting assets. Manual editing and simulation work without an Agent.

## Get OpenPE

Desktop packages bundle solvers, libraries and examples for **Windows x64**, **macOS arm64** and **Linux x64**. [Releases](https://github.com/fleaxiao/OpenPE/releases) · [Installation notes](docs/DEVELOPMENT.md#install-the-app)

Use Node.js 24 and Git to [run from source](docs/DEVELOPMENT.md#run-from-source). The development guide also covers browser mode, offline solver preparation, checks and packaging.

## Learn more

[Documentation](docs/README.md) · [Examples](docs/EXAMPLES.md) · [Architecture](docs/ARCHITECTURE.md) · [Coverage and limits](docs/README.md#coverage-and-limits) · [Contributing](AGENTS.md)

## License

[Apache-2.0](LICENSE). Third-party assets retain their licenses and attribution.
