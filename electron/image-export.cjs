const path = require('node:path');

function createImageExport({ showSaveDialog, atomicWrite, nativeImage }) {
  let pending = false;
  return async (options) => {
    if (pending) return null;
    pending = true;
    try {
      if (
        !options ||
        typeof options !== 'object' ||
        Object.keys(options).some((key) => !['dataUrl', 'width', 'height', 'name'].includes(key)) ||
        typeof options.dataUrl !== 'string' ||
        options.dataUrl.length > 48_000_000 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(options.dataUrl) ||
        ![options.width, options.height].every((n) => Number.isInteger(n) && n > 0 && n <= 4096) ||
        typeof options.name !== 'string' ||
        options.name.length > 4096
      )
        throw new Error('Invalid PNG export request.');
      const bytes = Buffer.from(options.dataUrl.slice('data:image/png;base64,'.length), 'base64');
      if (
        bytes.length < 33 ||
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        bytes.readUInt32BE(16) !== options.width ||
        bytes.readUInt32BE(20) !== options.height
      )
        throw new Error('Invalid PNG image or dimensions.');
      // Decode before the picker; truncated or malformed PNGs never reach writes.
      const decoded = nativeImage.createFromBuffer(bytes);
      const size = decoded.getSize();
      if (decoded.isEmpty() || size.width !== options.width || size.height !== options.height)
        throw new Error('Could not decode the PNG image.');
      const name =
        (path
          .basename(options.name)
          .replace(/(?:\.openpe\.json|\.kicad_pcb|\.png)$/i, '')
          .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
          .slice(0, 180) || 'board') + '.png';
      const result = await showSaveDialog({
        title: 'Export image',
        buttonLabel: 'Export',
        defaultPath: name,
        filters: [{ name: 'PNG image', extensions: ['png'] }],
      });
      if (result.canceled || !result.filePath) return null;
      const file = path.extname(result.filePath) ? result.filePath : result.filePath + '.png';
      if (path.extname(file).toLowerCase() !== '.png')
        throw new Error('Choose a .png filename for image export.');
      await atomicWrite(file, bytes);
      return { name: path.basename(file) };
    } finally {
      pending = false;
    }
  };
}
module.exports = { createImageExport };
