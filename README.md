# OpenPE

**Power electronics, from conversation to circuit.**

OpenPE · Electrical Engineering Studio is a local desktop workbench that brings Agent conversations and editable electrical designs together. Discuss a design on the left; build and inspect it on the right.

![OpenPE Home](assets/home.png)

## One workspace for your design

- **Design in native KiCad.** Edit schematics, place and route PCBs manually, work with Source, and run bounded ERC/DRC checks.
- **See it in 3D.** Inspect your board, draw custom symbols and footprints, and create Model CAD solids.
- **Explore circuit behaviour.** Run supported SPICE transients, estimate PCB temperature and measure two-terminal PCB parasitics.
- **Work with an Agent.** Use scoped project tools with Codex, Claude Code or Cursor, or review proposals from DeepSeek Harness and Pi.
- **Extend the workbench.** Install local JavaScript plugins with declared inputs and optional project read access. See the [plugin SDK](docs/PLUGINS.md#plugin-packages-and-sdk).
- **Keep your work local.** Manage independent projects and conversations, recover design drafts and compare local Git history.

Start with a curated example or your own circuit. Save a portable KiCad project with its supporting assets. Manual editing and simulation work without an Agent.

## Get OpenPE

Choose a published **Windows x64**, **macOS arm64** or **Linux x64** package from [Releases](https://github.com/fleaxiao/OpenPE/releases), or build locally. Linux requires glibc 2.41+ (Debian 13 or equivalent). Solvers, libraries and examples are bundled. See [installation notes](docs/DEVELOPMENT.md#install-the-app) for platform requirements.

To develop from source with Node.js 24 and Git:

```sh
npm ci
npm run libraries:download
npm run thermal:prepare
npm run dev
```

Initial preparation downloads pinned resources; unavailable solver releases need verified local archives or a maintainer rebuild. [Setup and development](docs/DEVELOPMENT.md) covers browser mode, resource access, checks and packaging.

## Learn more

[Documentation](docs/README.md) · [Examples](docs/EXAMPLES.md) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](AGENTS.md)

OpenPE supports bounded KiCad 10 and Model CAD workflows. See [coverage and limits](docs/README.md#coverage-and-limits) before relying on analysis or manufacturing output.

## License

[Apache-2.0](LICENSE). Third-party assets retain their licenses and attribution.
