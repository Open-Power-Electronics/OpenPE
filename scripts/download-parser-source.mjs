import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { t } from 'tar';
const exec = promisify(execFile);
const root = path.resolve('resources/third-party-source');
await mkdir(root, { recursive: true });
const sources = [
  [
    'occt-import-js-0.0.23',
    'https://codeload.github.com/kovacsv/occt-import-js/tar.gz/c2148e54b456b571238d35cac037d304053d64b2',
  ],
  [
    'opencascade-d2abb6d-source',
    'https://codeload.github.com/Open-Cascade-SAS/OCCT/tar.gz/d2abb6d844231cb8f29be6894440874a4700e4a5',
  ],
];
const manifest = [];
async function validateArchive(file, name) {
  let cmake = false,
    license = false,
    sourceFiles = 0;
  await t({
    file,
    strict: true,
    onReadEntry(entry) {
      if (entry.type !== 'File') return;
      cmake ||= /(^|\/)CMakeLists\.txt$/.test(entry.path);
      license ||= /(^|\/)LICENSE(?:_LGPL_21\.txt|\.md|\.txt)?$/.test(entry.path);
      if (/(^|\/)src\//.test(entry.path)) sourceFiles++;
    },
  });
  if (!cmake || !license || sourceFiles < (name.startsWith('opencascade') ? 10000 : 1))
    throw new Error('Incomplete corresponding-source archive.');
}
for (const [name, url] of sources) {
  const file = path.join(root, name + '.tar.gz');
  let bytes;
  try {
    bytes = await readFile(file);
    if (bytes.length < 1000 || bytes[0] !== 0x1f || bytes[1] !== 0x8b)
      throw new Error('Incomplete source archive.');
    await validateArchive(file, name);
  } catch {
    console.log(`Downloading corresponding source: ${name}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(`Source download failed (${response.status})`);
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 200_000_000) throw new Error('Source exceeds 200 MB.');
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b)
        throw new Error('Expected a source gzip archive.');
      await writeFile(file + '.tmp', bytes);
      await validateArchive(file + '.tmp', name);
      await rename(file + '.tmp', file);
    } catch (error) {
      console.log(
        `Source archive unavailable (${error.message}); fetching exact revision with Git.`,
      );
      const match = url.match(/^https:\/\/codeload.github.com\/(.+)\/tar.gz\/([a-f0-9]+)$/);
      const checkout = path.join(root, name + '-download');
      const options = { windowsHide: true, timeout: 600000, maxBuffer: 4_000_000 };
      await exec('git', ['init', checkout], options);
      await exec(
        'git',
        ['-C', checkout, 'fetch', '--depth', '1', `https://github.com/${match[1]}.git`, match[2]],
        options,
      );
      await exec(
        'git',
        [
          '-C',
          checkout,
          'archive',
          '--format=tar.gz',
          `--output=${file}.tmp`,
          'FETCH_HEAD',
          ...(name.startsWith('opencascade')
            ? [
                'src',
                'adm',
                'CMakeLists.txt',
                'LICENSE_LGPL_21.txt',
                'OCCT_LGPL_EXCEPTION.txt',
                'README.txt',
              ]
            : []),
        ],
        options,
      );
      await validateArchive(file + '.tmp', name);
      await rename(file + '.tmp', file);
      bytes = await readFile(file);
    }
  }
  manifest.push({ name, url, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`${name}: ${(bytes.length / 1e6).toFixed(1)} MB`);
}
await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
await writeFile(
  path.join(root, 'README.txt'),
  'Corresponding source for the unmodified occt-import-js 0.0.23 and its Open Cascade submodule.\nExtract the parser archive, then extract Open Cascade source into its occt/ directory. Follow the included README, CMakeLists.txt and tools/ build scripts using Emscripten 3.1.69.\nThe Open Cascade source archive may omit unrelated test data, samples and documentation; src/, build support and licenses are preserved.\nReplace the resulting JS and WASM in resources/app.asar.unpacked/node_modules/occt-import-js/dist/ to use a modified build. Reverse engineering to debug modifications to the LGPL libraries is permitted.\n',
);
