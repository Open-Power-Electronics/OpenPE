import type { DocumentState } from './workspace-state';

export type CloseSnapshot = {
  native: Pick<
    DocumentState,
    'source' | 'sourceDraft' | 'dirty' | 'activeSchematicId' | 'closedSchematicIds'
  >;
  ordinaryDraftRevision: number | null;
};
export type CloseChoice = 'save' | 'discard';
export type CloseDocument = CloseSnapshot & { id: string };

export function isCloseSnapshotUnsaved({ native, ordinaryDraftRevision }: CloseSnapshot) {
  return (
    native.dirty ||
    (native.sourceDraft !== null && native.sourceDraft !== native.source) ||
    ordinaryDraftRevision !== null
  );
}

const matches = (a: CloseSnapshot, b: CloseSnapshot) =>
  a.native.source === b.native.source &&
  a.native.sourceDraft === b.native.sourceDraft &&
  a.native.dirty === b.native.dirty &&
  a.ordinaryDraftRevision === b.ordinaryDraftRevision;

/** Decisions belong to the exact document revision the user reviewed. */
export class WorkspaceCloseReview {
  private decisions = new Map<string, CloseSnapshot & { choice: CloseChoice }>();

  accept(id: string, snapshot: CloseSnapshot, choice: CloseChoice) {
    this.decisions.set(id, { ...snapshot, native: { ...snapshot.native }, choice });
  }

  pending(documents: CloseDocument[]) {
    return documents.find((item) => {
      const decision = this.decisions.get(item.id);
      return isCloseSnapshotUnsaved(item) && (!decision || !matches(decision, item));
    });
  }

  retained(documents: CloseDocument[]) {
    return documents.filter((item) => {
      const decision = this.decisions.get(item.id);
      return decision?.choice !== 'discard' || !matches(decision, item);
    });
  }

  async finish(
    documents: () => CloseDocument[],
    persist: (retainedIds: Set<string>) => Promise<unknown>,
    approve: () => Promise<unknown>,
  ) {
    const before = documents();
    if (this.pending(before)) return false;
    const retainedIds = new Set(this.retained(before).map((item) => item.id));
    await persist(retainedIds);
    // A background change can require another decision or return a discarded
    // project to its clean baseline, which must be written back to recovery.
    const after = documents();
    if (this.pending(after)) return false;
    const retained = this.retained(after);
    if (retained.length !== retainedIds.size || retained.some(({ id }) => !retainedIds.has(id)))
      return false;
    await approve();
    return true;
  }
}
