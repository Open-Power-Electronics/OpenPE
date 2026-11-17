import { createRequire } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import { projectFromNativeFiles } from '../lib/project';
import {
  prepareExampleFootprints,
  verifyExampleFootprints,
} from '../server/example-footprints.mjs';
import { readProjectModelFile } from '../server/project-model-files.mjs';

const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const workspace = fileURLToPath(new URL('../', import.meta.url));
const normalize = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);

async function prepareDefaultExamples() {
  const footprints = await verifyExampleFootprints();
  const notice = path.join(workspace, 'public/licenses/ti-models.txt');
  const noticeInfo = await lstat(notice);
  if (
    !noticeInfo.isFile() ||
    noticeInfo.isSymbolicLink() ||
    noticeInfo.size < 1 ||
    noticeInfo.size > 128_000 ||
    normalize(await realpath(notice)) !== normalize(notice)
  )
    throw new Error('The original model notice must be a bounded regular build asset.');
  await readFile(notice);
  for (const entry of homeExampleCatalog) {
    const destination = path.join(workspace, homeExampleNativePath(entry.id));
    const bundle = await readNativeProject(destination);
    const project = projectFromNativeFiles(bundle);
    await prepareExampleFootprints(project, destination);
    for (const model of project.simulationModels ?? [])
      if (!(await readProjectModelFile(destination, model)))
        throw new Error(
          `Missing prepared example model ${model.id}. Run npm run simulation:download-examples.`,
        );
  }
  return { examples: homeExampleCatalog.length, footprints };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareDefaultExamples();
  console.log(
    `Verified ${result.examples} original native examples and ${result.footprints} pinned footprint/model assets.`,
  );
}
