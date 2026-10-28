/** Deterministic editor identities for native objects that have no UUID.
 * These are local identifiers, never file paths or security capabilities. */
export function nativeIdentity(value: string): string {
  const words = [2166136261, 2246822519, 3266489917, 668265263];
  for (let i = 0; i < value.length; i++) {
    for (let j = 0; j < words.length; j++)
      words[j] = Math.imul(words[j] ^ (value.charCodeAt(i) + j * 257), 16777619);
  }
  const h = words.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
