import { createHash } from 'node:crypto';

// These pinned STEP files expose their styles when OCCT reads the same B-rep
// solids without the single assembly occurrence. Match the bytes, not the name.
const assemblies = new Map([
  // WE-DD-7345straight
  [
    925203,
    {
      sha256: '510ce36606d5bb5bbc43f9cbaeb132fe25b394afab7aa94694ee7bb567c1b9ee',
      occurrence: '10|11|12|13|14076',
    },
  ],
  // WE-LQSH-2010
  [
    318722,
    {
      sha256: '727167f1f1bddea079427797a5d11420c219b42504e35cf1a6c22266b58bd8da',
      occurrence: '18|19|20|21|5201',
    },
  ],
  // WE-LQSH-2512
  [
    321471,
    {
      sha256: 'dfe55e75ffd9ad278e1cf10dd216f383c2c3ae5d02a9d3efbca9db59b772334f',
      occurrence: '18|19|20|21|5385',
    },
  ],
  // WE-CMB 744822222, the pinned derivative in the EMC assembly frame
  [
    3177842,
    {
      sha256: '89ff66fe9bc52b2ba95d24578985e15e193869fc959bb01234f5a388fa484999',
      occurrence: '18|19|20|21|42456',
    },
  ],
]);

export function restoreStepAssemblyColors(bytes, meshes, read) {
  const selected = assemblies.get(bytes.byteLength);
  if (!selected || createHash('sha256').update(bytes).digest('hex') !== selected.sha256) return;

  // Only remove the assembly relationship, occurrence and transform. The
  // original STEP entities, including the ordered solids and faces, supply
  // the styles for this second read. Its geometry never leaves the worker.
  const source = Buffer.from(bytes).toString('latin1');
  const detached = source.replace(
    new RegExp(`^#(?:${selected.occurrence})=[^;]*;\\r?\\n`, 'gm'),
    '',
  );
  const appearance = read(Buffer.from(detached, 'latin1'));
  if (
    !appearance.success ||
    appearance.meshes?.length !== meshes.length ||
    meshes.some(
      (mesh, index) =>
        mesh.brep_faces?.length === undefined ||
        mesh.brep_faces.length !== appearance.meshes[index].brep_faces?.length,
    )
  )
    return;

  for (const [index, mesh] of meshes.entries()) {
    const style = appearance.meshes[index];
    if (style.color) mesh.color ??= style.color;
    for (const [face, range] of mesh.brep_faces.entries())
      range.color ??= style.brep_faces[face].color;
  }
}
