import { createHash } from 'node:crypto';
import { createHomeExample } from './create-home-example';
import { homeExampleCatalog } from './home-examples';
import { serializeProject } from './project';

// Build-only deterministic factories: no model downloads or vendor model bytes.
export function defaultExamples() {
  return homeExampleCatalog.map((entry) => {
    let source: string | undefined;
    return {
      id: entry.id,
      key: `example:${entry.id}`,
      name: entry.title,
      createSource: () =>
        (source ??= serializeProject(
          createHomeExample(entry.id, (sourceId) => {
            const hash = createHash('sha256')
              .update(`openpe-default-example-v2:${entry.id}:${sourceId}`)
              .digest('hex');
            return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          }),
        )),
    };
  });
}
