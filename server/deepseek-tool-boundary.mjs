// Loaded only by OpenPE's private per-turn DeepSeek ACP patch. This module has
// no third-party imports: the installed harness supplies its own tool registry.
export const name = 'openpe-tool-boundary';
export const inject = ['tools'];
export function apply(ctx) {
  if (typeof ctx.tools?.guard !== 'function')
    throw new Error('This DeepSeek Harness version cannot enforce the OpenPE tool boundary.');
  ctx.tools.guard(() => 'OpenPE provides context-only conversations; built-in tools are disabled.');
  // ACP explicitly depends on this service, so no prompt can precede the guard.
  ctx.provide('openpeToolBoundary', true);
}
