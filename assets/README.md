# Architecture source

[architecture.drawio](architecture.drawio) is the editable architecture source for OpenPE. Open it with diagrams.net or a compatible editor. [The architecture contract](../docs/ARCHITECTURE.md) maps modules and artifacts to code; [AGENTS.md](../AGENTS.md) defines engineering requirements.

The single Architecture sheet shows implemented modules and call/data flow, not import dependencies or separate processes. Human and Agent adapters share the Uniform API. Core owns design transactions; host adapters own file access and execution. Native projects, STEP/OpenSCAD exports and private stores remain separate.

Update the diagram and contract together when implemented boundaries change. `npm run check:architecture` checks code imports; `capabilities.list` defines mounted capability availability.

[vision.drawio](vision.drawio) preserves the original Page-2 concept in the Original Page-2 sheet and adapts it to the current project in the Vision sheet. Solid nodes show the implemented foundation; dashed nodes describe future task goals, analytical studies and broader reviewed guidance. Future labels are conceptual directions, not registered APIs, supported features or delivery commitments. The vision retains ProjectCore transactions, native KiCad ownership, scoped tools and host execution boundaries; the current architecture and feature contracts remain authoritative for implemented behaviour.

`home.png` is the README's 1440 × 480 Home hero crop. Regenerate it with `node scripts/check-brand-ui.mjs --update-readme-screenshot`, then inspect the image. The capture uses an isolated headless renderer and mocked services, without Electron, providers or solvers.
