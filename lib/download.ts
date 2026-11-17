/** Browser fallback only; desktop project writes use the native file bridge. */
export function downloadText(content: string, filename: string, type = 'text/plain;charset=utf-8') {
  downloadBlob(new Blob([content], { type }), filename);
}
export function downloadBytes(content: Uint8Array, filename: string, type: string) {
  downloadBlob(new Blob([new Uint8Array(content)], { type }), filename);
}
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
