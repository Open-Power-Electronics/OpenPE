# Design references and brand previews

This directory holds visual research snapshots and generated OpenPE identity previews. [DESIGN.md](../DESIGN.md) defines the current UI contract; [AGENTS.md](../AGENTS.md) defines engineering and delivery rules. These reference files are excluded from the packaged application. Runtime styles live in `app/globals.css` and `app/workspace.css`; production brand assets live in `public/brand/`.

## Contents and provenance

| File                                                                                 | Purpose and recorded source                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [open-design-home.png](open-design-home.png)                                         | Home workspace research capture; [official Open Design reference](https://github.com/nexu-io/open-design/blob/main/docs/screenshots/product-tour/home-workspace-2026-09-30-220844.png)                       |
| [open-design-studio.webp](open-design-studio.webp)                                   | Conversation/canvas workflow reference; [official studio reference](https://github.com/nexu-io/open-design/blob/main/docs/screenshots/product-tour/studio-prototype-2026.webp), recorded download 2026-10-10 |
| [open-design-tokens.css](open-design-tokens.css)                                     | Neutral/green palette research snapshot; [official token source](https://github.com/nexu-io/open-design/blob/main/apps/web/src/styles/tokens.css), recorded retrieval 2026-10-10                             |
| [`openpe-logo-preview.svg`](openpe-logo-preview.svg), [PNG](openpe-logo-preview.png) | Generated Signal E presentation on light/dark surfaces and at small icon sizes                                                                                                                               |
| [`openpe-titlebar-preview.png`](openpe-titlebar-preview.png)                         | Generated presentation of the native product title, **OpenPE · Electrical Engineering Studio**                                                                                                               |

The Open Design links record source locations. The local snapshots are not automatically synchronized with upstream, and no retrieval date or source commit is recorded here for the Home capture. Keep source attribution when refreshing them and record the exact source, retrieval date and revision when available.

The Open Design repository is distributed under Apache-2.0; depicted third-party example content retains its owners' rights. These screenshots are research material. OpenPE's UI and Signal E artwork are independently authored; schematic libraries and example designs retain their separate KiCad/dataset attribution and licenses.

The token snapshot is not imported as an application stylesheet. OpenPE maps the researched neutral and green values into its own semantic tokens, including brightness-aware drawing colours. Current dimensions, interactions and appearance rules come from DESIGN.md.

## Signal E generation

Signal E is independently authored artwork retained for OpenPE. Its smooth charcoal E, bright-green electrical signal and fine green outline form the non-pixel identity. The transparent [SVG master](../public/brand/openpe-mark.svg) is the sole source of logo geometry.

After an intentional master change, regenerate assets from the repository root:

```sh
node scripts/brand-assets.mjs
```

The script writes SVG variants/lockups and transparent PNG/ICO production assets under `public/brand/` and `build/`, plus the three OpenPE preview files listed above. It does not recreate the Open Design research snapshots. Use the original charcoal Signal E mark on both light and dark application surfaces. The [Signal E design contract](../DESIGN.md#brand-signal-e) describes the README lockups.

The logo presentation sheet supplies its own backgrounds. Production marks retain transparency. The title preview illustrates product identity; the actual Windows caption-toolbar layout is specified in DESIGN.md and implemented in `electron/main.cjs` and the renderer.

## Maintenance and verification

- Edit brand geometry only in the master, never in a generated preview. Inspect regenerated icons at native sizes and confirm transparent output.
- Keep research snapshots separate from application assets, electrical design data and symbol libraries. Preserve their source and rights information.
- Documentation-only edits need content, links, paths and Markdown formatting checks. They do not require regenerating images, downloading references, launching Electron or running providers/solvers.
- Desktop captures and visual desktop checks require explicit user authorization. A generated preview is a design aid; it does not establish that a running application loaded current assets.
