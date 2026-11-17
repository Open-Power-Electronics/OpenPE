const { chmod, lstat, readdir } = require('node:fs/promises');
const path = require('node:path');

// Debian/AppImage resources are owned by root after installation or mounting.
// A checkout's restrictive umask must not make the installed app unreadable.
module.exports = async function afterPack({ electronPlatformName, appOutDir }) {
  if (electronPlatformName !== 'linux') return;
  // Targets create .desktop files after this hook; they must also be readable
  // when installed as root, independently of the invoking shell's umask.
  process.umask(0o022);
  const visit = async (file) => {
    const info = await lstat(file);
    if (info.isDirectory()) {
      await chmod(file, 0o755);
      for (const name of await readdir(file)) await visit(path.join(file, name));
    } else if (info.isFile()) {
      await chmod(file, info.mode & 0o111 ? 0o755 : 0o644);
    } else {
      throw new Error(`Linux package contains a link or special file: ${file}.`);
    }
  };
  await visit(appOutDir);
};
