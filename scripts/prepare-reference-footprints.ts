import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../resources/example-catalog/manifest.json';
import { parseSExpr, children, child, val, writeSExpr } from '../lib/sexpr';

// Explicit build-time source checkout, never an installed user library.
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('Pass the pinned reference-circuit checkout directory.');
const destination = 'resources/example-catalog/footprints';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const footprints = new Map<
  string,
  { id: string; file?: string; sha256?: string; models: string[] }
>();
const models = new Map<string, { file: string; sha256: string; source: string }>();
for (const entry of manifest.examples) {
  const raw = await readFile(entry.source.pcb.path);
  if (digest(raw) !== entry.source.pcb.sha256) throw new Error('Pinned PCB checksum mismatch.');
  const board = parseSExpr(raw.toString());
  for (const footprint of children(board, 'footprint')) {
    const id = val(footprint);
    if (footprints.has(id)) continue;
    const [library, name] = id.split(':');
    const record: { id: string; file?: string; sha256?: string; models: string[] } = {
      id,
      models: [],
    };
    for (const model of children(footprint, 'model')) {
      const relative = val(model)
        .replace(/^\$\{KICAD\d+_3DMODEL_DIR\}\//, '')
        .replace(/\.wrl$/i, '.step');
      if (!/^[\w.+-]+\.3dshapes\/[\w.+(), -]+\.step$/i.test(relative))
        throw new Error(`Unsupported source model: ${relative}`);
      record.models.push(relative);
      if (!models.has(relative)) {
        let source = `resources/kicad/10.0.0/models/${relative}`;
        try {
          await stat(source);
        } catch {
          source = path.join(sourceRoot, 'res/kicad/3dmodels', relative);
        }
        const bytes = await readFile(source);
        if (!bytes.subarray(0, 100).toString().includes('ISO-10303-21'))
          throw new Error('Expected STEP data.');
        const file = `models/${relative}`;
        await mkdir(path.dirname(`${destination}/${file}`), { recursive: true });
        await writeFile(`${destination}/${file}`, bytes);
        models.set(relative, {
          file,
          sha256: digest(bytes),
          source: source.startsWith('resources/')
            ? source
            : `res/kicad/3dmodels/${relative}`,
        });
      }
      model[1] = JSON.stringify(`\${KIPRJMOD}/footprints/models/${relative}`);
    }
    try {
      await stat(`resources/kicad/10.0.0/footprints/${library}.pretty/${name}.kicad_mod`);
    } catch {
      // The custom package exists only inside the source expert PCB. Preserve its
      // local geometry; remove board placement, nets and instance-only links.
      const module = footprint.filter(
        (n) =>
          !Array.isArray(n) ||
          !['at', 'uuid', 'path', 'sheetfile', 'sheetname', 'locked'].includes(String(n[0])),
      );
      module[1] = JSON.stringify(name);
      for (const pad of children(module, 'pad'))
        for (let i = pad.length - 1; i > 0; i--)
          if (
            Array.isArray(pad[i]) &&
            ['net', 'uuid', 'pinfunction', 'pintype'].includes(String((pad[i] as string[])[0]))
          )
            pad.splice(i, 1);
      const reference = children(module, 'property').find((n) => val(n) === 'Reference');
      if (reference) reference[2] = JSON.stringify('REF**');
      if (!child(module, 'version'))
        module.splice(2, 0, ['version', '20260206'], ['generator', 'openpe']);
      const bytes = Buffer.from(writeSExpr(module) + '\n');
      record.file = `${library}.pretty/${name}.kicad_mod`;
      record.sha256 = digest(bytes);
      await mkdir(path.dirname(`${destination}/${record.file}`), { recursive: true });
      await writeFile(`${destination}/${record.file}`, bytes);
    }
    footprints.set(id, record);
  }
}
await copyFile('resources/kicad/10.0.0/models/LICENSE.md', `${destination}/LICENSE.md`);
await copyFile('resources/kicad/10.0.0/models/CREDITS.md', `${destination}/CREDITS.md`);
await writeFile(
  `${destination}/manifest.json`,
  JSON.stringify(
    { version: 1, footprints: [...footprints.values()], models: Object.fromEntries(models) },
    null,
    2,
  ) + '\n',
);
await writeFile(
  `${destination}/NOTICE.txt`,
  'KiCad library subset for the nine curated reference examples.\nOfficial KiCad 10 models are copied unchanged from the pinned bundled library.\nMissing models are copied unchanged from the pinned source checkout under res/kicad/3dmodels.\nThe WE-DD-7345straight footprint is extracted from the hash-pinned LM25017 expert PCB; board-instance links are removed and its model uses a project-relative reference.\nSee manifest.json for SHA-256 hashes and sources, ../manifest.json for the source PCB hash, LICENSE.md and CREDITS.md for upstream terms and attribution.\n',
);
console.log(`Prepared ${footprints.size} packages, ${models.size} STEP models.`);
