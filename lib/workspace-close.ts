export type CloseSnapshot = { source: string; sourceDraft: string | null };
export type CloseChoice = 'save' | 'discard';
export type CloseDocument = CloseSnapshot & { id: string; unsaved: boolean };

const matches = (a: CloseSnapshot, b: CloseSnapshot) =>
  a.source === b.source && a.sourceDraft === b.sourceDraft;

/** Decisions belong to the exact document revision the user reviewed. */
export class WorkspaceCloseReview {
  private decisions = new Map<string, CloseSnapshot & { choice: CloseChoice }>();

  accept(id: string, snapshot: CloseSnapshot, choice: CloseChoice) {
    this.decisions.set(id, { ...snapshot, choice });
  }

  pending(documents: CloseDocument[]) {
    return documents.find((item) => {
      const decision = this.decisions.get(item.id);
      return item.unsaved && (!decision || !matches(decision, item));
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
    if (this.pending(documents())) return false;
    await persist(new Set(this.retained(documents()).map((item) => item.id)));
    // An Agent can finish editing any project during the recovery write.
    if (this.pending(documents())) return false;
    await approve();
    return true;
  }
}
