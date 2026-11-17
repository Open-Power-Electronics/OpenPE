/** Small deterministic, uncompressed ZIP writer. File names are single bounded
 * UTF-8 leaves and contents are generated text; no paths or ZIP64 are accepted.
 */
export function exportZip(files: { name: string; source: string }[]): Uint8Array {
  if (files.length > 128) throw new Error('Too many export files.');
  const encoder = new TextEncoder(),
    names = new Set<string>();
  let length = 22;
  const entries = files.map((file) => {
    if (
      !file.name ||
      file.name.length > 200 ||
      /[\\/\x00-\x1f]/.test(file.name) ||
      ['.', '..'].includes(file.name) ||
      names.has(file.name.toLowerCase())
    )
      throw new Error('Invalid export archive filename.');
    names.add(file.name.toLowerCase());
    const name = encoder.encode(file.name),
      bytes = encoder.encode(file.source);
    length += 76 + 2 * name.length + bytes.length;
    if (length > 96 * 1024 * 1024) throw new Error('The manufacturing export exceeds 96 MiB.');
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return { name, bytes, crc: (crc ^ 0xffffffff) >>> 0, offset: 0 };
  });
  const output = new Uint8Array(length),
    view = new DataView(output.buffer);
  let cursor = 0;
  const u16 = (v: number) => {
    view.setUint16(cursor, v, true);
    cursor += 2;
  };
  const u32 = (v: number) => {
    view.setUint32(cursor, v, true);
    cursor += 4;
  };
  const raw = (v: Uint8Array) => {
    output.set(v, cursor);
    cursor += v.length;
  };
  for (const entry of entries) {
    entry.offset = cursor;
    u32(0x04034b50);
    u16(20);
    u16(0x800);
    u16(0);
    u16(0);
    u16(33);
    u32(entry.crc);
    u32(entry.bytes.length);
    u32(entry.bytes.length);
    u16(entry.name.length);
    u16(0);
    raw(entry.name);
    raw(entry.bytes);
  }
  const start = cursor;
  for (const entry of entries) {
    u32(0x02014b50);
    u16(20);
    u16(20);
    u16(0x800);
    u16(0);
    u16(0);
    u16(33);
    u32(entry.crc);
    u32(entry.bytes.length);
    u32(entry.bytes.length);
    u16(entry.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(entry.offset);
    raw(entry.name);
  }
  const size = cursor - start;
  u32(0x06054b50);
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(size);
  u32(start);
  u16(0);
  return output;
}
