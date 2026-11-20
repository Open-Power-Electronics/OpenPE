import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { assertContainedPath, canonicalDirectory } from './host-path.cjs';

export const rawKiCadExtensions = ['kicad_pro', 'kicad_sch', 'kicad_pcb'];
const fileBudget = 2 * 1024 * 1024;
const historyBudget = 128 * 1024;

async function readFile(file, remaining) {
  const message = 'Choose a regular KiCad file in a regular folder.';
  const parent = await canonicalDirectory(path.dirname(file), { message });
  const options = { kind: 'file', message };
  const contained = await assertContainedPath(parent, file, options);
  const original = await lstat(contained);
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  const handle = await open(contained, O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (
      !original.isFile() ||
      !info.isFile() ||
      original.dev !== info.dev ||
      original.ino !== info.ino
    )
      throw new Error(message);
    if (info.size > remaining) throw new Error('Choose at most 2 MiB of KiCad files in total.');
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    await assertContainedPath(parent, file, options);
    const current = await lstat(contained);
    const after = await handle.stat();
    if (
      !current.isFile() ||
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs ||
      offset !== info.size
    )
      throw new Error('The KiCad file changed while being read. Choose it again.');
    const bytes = buffer.subarray(0, offset);
    if (!isUtf8(bytes) || bytes.includes(0))
      throw new Error('Choose KiCad files containing UTF-8 text.');
    return { name: path.basename(file), bytes: bytes.length, source: bytes.toString('utf8') };
  } finally {
    await handle.close();
  }
}

export function createRawKiCadSession() {
  let active = false;
  let epoch = 0;
  let selection;
  return {
    active: () => active,
    setActive(value) {
      active = value;
      ++epoch;
      selection = undefined;
    },
    async select(paths) {
      if (!active) throw new Error('Enable Raw KiCad mode before choosing files.');
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8)
        throw new Error('Choose 1 to 8 KiCad files.');
      const revision = epoch;
      const names = new Set();
      let remaining = fileBudget;
      const files = [];
      for (const file of paths) {
        if (
          typeof file !== 'string' ||
          !path.isAbsolute(file) ||
          !rawKiCadExtensions.includes(path.extname(file).slice(1).toLowerCase())
        )
          throw new Error('Choose KiCad files with a supported extension.');
        const name = path.basename(file).toLowerCase();
        if (names.has(name)) throw new Error('Choose files with distinct filenames.');
        names.add(name);
        const captured = await readFile(file, remaining);
        remaining -= captured.bytes;
        files.push(captured);
      }
      if (epoch !== revision) throw new Error('Raw KiCad mode changed while reading the files.');
      const id = randomUUID();
      selection = { id, files };
      return { id, names: files.map(({ name }) => name) };
    },
    prompt(id, text, history) {
      if (!active || !selection || id !== selection.id)
        throw new Error('Choose KiCad files before sending.');
      if (
        !Array.isArray(history) ||
        history.length > 16 ||
        history.some(
          (entry) =>
            !entry ||
            typeof entry !== 'object' ||
            Object.keys(entry).length !== 2 ||
            (entry.role !== 'user' && entry.role !== 'assistant') ||
            typeof entry.text !== 'string',
        ) ||
        Buffer.byteLength(JSON.stringify(history)) > historyBudget
      )
        throw new Error('Invalid or oversized Raw KiCad conversation history.');
      return [
        text,
        ...(history.length ? [`Conversation history:\n${JSON.stringify(history)}`] : []),
        ...selection.files.map(
          ({ name, bytes, source }) =>
            `KiCad file ${JSON.stringify(name)} (${bytes} UTF-8 bytes):\n${source}`,
        ),
      ].join('\n\n');
    },
  };
}
