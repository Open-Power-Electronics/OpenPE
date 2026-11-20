const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const keys = (value, allowed) =>
  record(value) && Object.keys(value).every((key) => allowed.includes(key));
const idPattern = /^[a-z][a-z0-9-]{0,63}@[a-z][a-z0-9-]{0,63}$/;
const capabilityPattern = /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;

function validateExternalSchema(schema) {
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > 4096 || depth > 16) throw new Error('Plugin input schema is too complex.');
    if (value && typeof value === 'object') {
      // Untrusted regular expressions must never execute on the UI/service thread.
      if (Object.hasOwn(value, 'pattern'))
        throw new Error('Plugin input schemas do not support regular expressions.');
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
  }
  if (JSON.stringify(schema).length > 65536) throw new Error('Plugin input schema is too large.');
  visit(schema, 0);
}

/** Project data names are single components; executable paths and inferred permissions are rejected. */
export function validatePluginManifest(value, { builtin = false } = {}) {
  if (
    !keys(value, [
      'apiVersion',
      'id',
      'name',
      'version',
      'description',
      'detail',
      'author',
      'category',
      'capabilities',
      'runtime',
      'permissions',
      'entry',
      'contributes',
      'projectDirectory',
    ]) ||
    value.apiVersion !== 1 ||
    !text(value.id, 129) ||
    !idPattern.test(value.id) ||
    !text(value.name) ||
    !text(value.description, 2000) ||
    !text(value.author) ||
    !text(value.version, 50) ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) ||
    (value.detail !== undefined && !text(value.detail, 10000)) ||
    (value.category !== undefined && !text(value.category)) ||
    (value.capabilities !== undefined &&
      (!Array.isArray(value.capabilities) ||
        value.capabilities.length > 32 ||
        value.capabilities.some((item) => !text(item)))) ||
    value.runtime !== (builtin ? 'builtin' : 'javascript') ||
    !Array.isArray(value.permissions) ||
    value.permissions.length > 1 ||
    value.permissions.some((permission) => permission !== 'project.read') ||
    !keys(value.contributes, builtin ? ['capabilities'] : ['commands'])
  )
    throw new Error('Invalid OpenPE plugin manifest or unsupported API version.');
  if (builtin) {
    if (
      !text(value.projectDirectory, 64) ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.projectDirectory) ||
      ['models', 'footprints', 'symbols'].includes(value.projectDirectory) ||
      value.entry !== undefined ||
      !Array.isArray(value.contributes.capabilities) ||
      value.contributes.capabilities.some((id) => !capabilityPattern.test(id)) ||
      new Set(value.contributes.capabilities).size !== value.contributes.capabilities.length
    )
      throw new Error('Invalid built-in plugin directory or capability declarations.');
  } else {
    if (value.projectDirectory !== undefined)
      throw new Error('Local plugin project directories are bound to their qualified IDs.');
    const commands = value.contributes.commands;
    const [name, publisher] = value.id.split('@');
    const prefix = `extension.${publisher.replaceAll('-', '_')}.${name.replaceAll('-', '_')}.`;
    if (
      value.entry !== 'main.js' ||
      !Array.isArray(commands) ||
      commands.length < 1 ||
      commands.length > 32 ||
      new Set(commands.map((command) => command?.id)).size !== commands.length ||
      commands.some(
        (command) =>
          !keys(command, ['id', 'name', 'description', 'inputSchema', 'handler']) ||
          !text(command.id) ||
          !command.id.startsWith(prefix) ||
          !/^extension\.[a-z0-9_]+\.[a-z0-9_]+\.[a-z][a-zA-Z0-9]*$/.test(command.id) ||
          !text(command.name) ||
          !text(command.description, 2000) ||
          !record(command.inputSchema) ||
          !text(command.handler, 64) ||
          !/^[a-z][a-zA-Z0-9]*$/.test(command.handler),
      )
    )
      throw new Error('Invalid sandbox plugin commands or capability namespace.');
    for (const command of commands) validateExternalSchema(command.inputSchema);
  }
  return structuredClone(value);
}

export function createPluginCatalog(manifests) {
  const catalog = manifests.map((value) => validatePluginManifest(value, { builtin: true }));
  if (new Set(catalog.map((manifest) => manifest.id)).size !== catalog.length)
    throw new Error('Duplicate OpenPE plugin ID.');
  if (new Set(catalog.map((manifest) => manifest.projectDirectory)).size !== catalog.length)
    throw new Error('Duplicate OpenPE plugin project directory.');
  const capabilities = catalog.flatMap((manifest) => manifest.contributes.capabilities);
  if (new Set(capabilities).size !== capabilities.length)
    throw new Error('Duplicate OpenPE plugin capability.');
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(catalog);
}
