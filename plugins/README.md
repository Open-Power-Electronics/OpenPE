# OpenPE plugins

Each built-in feature owns its manifest and implementation. The
[manifest catalog](catalog.mjs) registers the bundled features, and
[`renderer.tsx`](renderer.tsx) registers their artwork. [Bundled plugin surfaces](../docs/PLUGINS.md#bundled-plugin-surfaces)
lists the features and their workbench entry points.

[`runtime/`](runtime/) supplies shared validation, capability scopes, package
storage and sandbox execution. See the [plugin contract and SDK](../docs/PLUGINS.md#plugin-packages-and-sdk)
for authoring, installation and permissions.
