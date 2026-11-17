/** Only fixed official KiCad resource paths, never native paths or caller URLs. */
export function validateOfficialModelPath(relative) {
  if (
    typeof relative !== 'string' ||
    !/^[\w.+-]+\.3dshapes\/[\w.+(), -]+\.(?:step|stp)$/i.test(relative)
  )
    throw new Error('This model reference is not a supported official STEP path.');
  return relative;
}

export function officialModelRelativePath(reference) {
  if (typeof reference !== 'string' || !/^\$\{KICAD\d+_3DMODEL_DIR\}\//.test(reference))
    throw new Error('Unsupported library STEP reference.');
  return validateOfficialModelPath(
    reference.replace(/^\$\{KICAD\d+_3DMODEL_DIR\}\//, '').replace(/\.wrl$/i, '.step'),
  );
}
