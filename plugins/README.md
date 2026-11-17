# OpenPE plugins

Each built-in feature owns its manifest and implementation in one directory:
`spice-simulation/`, `layout-thermal/`, `pe-layout-skill/` and `layout-parasitics/`.
`catalog.mjs` registers the built-in manifests; `renderer.tsx` registers artwork.
`runtime/` supplies shared validation, capability scopes, local package storage
and sandbox execution.

See the [plugin contract and SDK](../docs/PLUGINS.md#plugin-packages-and-sdk)
for package authoring, runtime installation, permissions and execution limits.
