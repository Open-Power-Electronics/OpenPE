import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, open, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { validateSimulationModels } from './simulation-model-format.mjs';

export function verifyProjectModelBytes(model, bytes) {
  validateSimulationModels([model]);
  if (
    !bytes.length ||
    bytes.length > 128 * 1024 ||
    createHash('sha256').update(bytes).digest('hex') !== model.sha256
  )
    throw new Error(
      `Simulation model ${model.id} failed its integrity check. Download the verified model again.`,
    );
  return bytes;
}
async function modelPath(projectFile, model, create) {
  validateSimulationModels([model]);
  if (!projectFile) return null;
  const root = await realpath(path.dirname(path.resolve(projectFile)));
  const directory = path.join(root, path.dirname(model.file));
  if (create)
    await mkdir(directory).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  const info = await lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  const resolved = await realpath(directory);
  const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
  if (!info.isDirectory() || info.isSymbolicLink() || normalize(resolved) !== normalize(directory))
    throw new Error('The project model folder must be a real directory beside the project file.');
  const file = path.join(directory, path.basename(model.file));
  const existing = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error(
      'A referenced simulation model must be a regular file in the project model folder.',
    );
  return { file, existing };
}
export async function readProjectModelFile(projectFile, model) {
  const target = await modelPath(projectFile, model, false);
  if (!target?.existing) return null;
  if (target.existing.size > 128 * 1024) throw new Error('A simulation model file exceeds 128 KB.');
  const handle = await open(target.file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 128 * 1024)
      throw new Error('A simulation model file exceeds 128 KB or is not a regular file.');
    const bytes = Buffer.alloc(128 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const chunk = await handle.read(bytes, size, bytes.length - size, null);
      if (!chunk.bytesRead) break;
      size += chunk.bytesRead;
    }
    return verifyProjectModelBytes(model, bytes.subarray(0, size));
  } finally {
    await handle.close();
  }
}
export async function writeProjectModelFile(projectFile, model, bytes) {
  verifyProjectModelBytes(model, bytes);
  if (!projectFile) return;
  const existing = await readProjectModelFile(projectFile, model);
  if (existing) return;
  const target = await modelPath(projectFile, model, true);
  const temporary = `${target.file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await modelPath(projectFile, model, false);
    await rename(temporary, target.file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export async function prepareProjectModelFiles(project, destination, sourceFile, store, signal) {
  validateSimulationModels(project.simulationModels);
  for (const model of project.simulationModels ?? []) {
    signal.throwIfAborted();
    const sourceBytes = await readProjectModelFile(sourceFile, model);
    const bytes =
      sourceBytes ??
      (await readProjectModelFile(destination, model)) ??
      (await store(model.id, signal));
    signal.throwIfAborted();
    await writeProjectModelFile(destination, model, bytes);
  }
}
