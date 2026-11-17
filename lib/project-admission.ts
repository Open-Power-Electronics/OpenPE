import { ownProject } from './immutable-project';
import { serializeProject, type Project } from './project';

type Admission = Readonly<{ source: string; project: Project }>;

/** Temporary in-process handoff between workspace admission and the first Core
 * mount. Every entry is detached and validated here; caller freezing grants no
 * trust. Tokens, paths and pending handoffs never enter workspace recovery. */
export function createProjectAdmissions(maximum = 12) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 12)
    throw new Error('Project admission supports at most 12 pending projects.');
  const pending = new Map<string, Admission>();
  return {
    stage(id: string, input: Project): string {
      if (!pending.has(id) && pending.size >= maximum)
        throw new Error('Too many projects are waiting to open.');
      const project = ownProject(input);
      const source = serializeProject(project);
      // Only this closure can publish an entry. An exact Source match binds the
      // Core initializer to that validated snapshot, including all native files.
      pending.set(id, Object.freeze({ source, project }));
      return source;
    },
    get(id: string, source: string): Project | undefined {
      const entry = pending.get(id);
      return entry?.source === source ? entry.project : undefined;
    },
    release(id: string): void {
      pending.delete(id);
    },
    retain(ids: ReadonlySet<string>): void {
      for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
    },
    get size() {
      return pending.size;
    },
  };
}
