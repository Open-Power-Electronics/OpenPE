let encoding: { encoder: TextEncoder; scratch: Uint8Array } | undefined;

/** Match TextEncoder's USV-string byte count without allocating the full output. */
export function exceedsUtf8ByteLimit(source: string, limit: number): boolean {
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new RangeError('UTF-8 byte limit must be a nonnegative safe integer.');
  // A UTF-16 code unit requires one to three UTF-8 bytes. A surrogate pair
  // requires four bytes for its two code units; lone surrogates become U+FFFD.
  if (source.length > limit) return true;
  if (source.length * 3 <= limit || !/[^\x00-\x7f]/.test(source)) return false;

  const { encoder, scratch } = (encoding ??= {
    encoder: new TextEncoder(),
    scratch: new Uint8Array(65_536),
  });
  let read = 0;
  let bytes = 0;
  while (read < source.length) {
    // Let the encoder consume complete scalar values instead of slicing the
    // input at arbitrary code-unit boundaries. The private buffer is reused
    // synchronously and is never returned to a caller.
    const next = encoder.encodeInto(source.slice(read), scratch);
    read += next.read;
    bytes += next.written;
    if (bytes > limit) return true;
  }
  return false;
}
