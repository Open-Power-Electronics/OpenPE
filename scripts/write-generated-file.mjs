import { lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';

// Preserve unchanged output identities so regeneration does not invalidate
// renderer watchers and incremental build inputs. Changed files still publish
// by replacement, without truncating files mapped by concurrent Windows readers.
export async function writeGeneratedFile(file, contents) {
  try {
    const info = await lstat(file);
    if (info.isFile() && (await readFile(file)).equals(Buffer.from(contents))) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents);
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, file);
        return true;
      } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
