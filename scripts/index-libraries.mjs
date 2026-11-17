import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLibraryService } from '../server/libraries.mjs';
const root = path.resolve('resources/kicad/10.0.0');
const libraries = createLibraryService({ root, dataDir: path.resolve('.openpe/library-build') });
try {
  const index = await libraries.request({ action: 'snapshot' });
  await writeFile(path.join(root, 'library-index.json'), JSON.stringify(index));
  console.log(
    `Bundled catalog: ${index.catalogs.symbols.length} symbols, ${index.catalogs.footprints.length} footprints.`,
  );
} finally {
  libraries.close();
}
