/** Qualified provider plugin IDs accepted by commands and origin receipts. */
export const validPluginId = (id) =>
  typeof id === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}@[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id);
