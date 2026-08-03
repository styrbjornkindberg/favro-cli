/**
 * Passthrough implementations for the two `safety.ts` helpers that the scope
 * tests must NOT stub out.
 *
 * Those tests `jest.mock('../../lib/safety')` wholesale, which is right for
 * `checkScope` — it reaches the wire — but wrong for
 * `boardOfCard` and `checkResolvedScope`. Those two ARE the behaviour under
 * test: one decides what board a write lands on, the other decides whether to
 * pay for that answer at all. Auto-mocked they return `undefined`, and every
 * assertion about which board reached the lock would pass against a stub that
 * resolves nothing. So they are wired back to a faithful reimplementation here,
 * over the already-mocked `CardsAPI` and `readConfig`.
 *
 * Kept out of `__tests__/` on purpose: `testMatch` collects every `.ts` under
 * that directory, so a helper living there is a suite with no tests in it.
 */

/** Wire the resolution helpers in `safety.ts` back to real behaviour. */
export function passThroughScopeResolution(
  safety: any,
  config: any,
  CardsAPI: { prototype: { getCard: (ref: string) => Promise<{ boardId?: string } | undefined> } },
  Comments?: { prototype: { getComment: (id: string) => Promise<{ cardId?: string } | undefined> } },
): void {
  safety.boardOfCard.mockImplementation(async (_client: unknown, cardRef: string) => {
    if (!cardRef) return '';
    try {
      return (await CardsAPI.prototype.getCard(cardRef))?.boardId ?? '';
    } catch {
      // Wrapped, and fail-CLOSED: an unreadable card is UNCHECKABLE, not exempt.
      return '';
    }
  });

  if (Comments) {
    safety.boardOfComment.mockImplementation(async (client: unknown, commentId: string) => {
      let cardRef = '';
      try {
        cardRef = (await Comments.prototype.getComment(commentId))?.cardId ?? '';
      } catch {
        // Wrapped for the same reason as the card hop: a resolver that REJECTS
        // never reaches the lock, which is worse than one that resolves ''.
        return '';
      }
      return safety.boardOfCard(client, cardRef);
    });
  }

  safety.checkResolvedScope.mockImplementation(
    async (client: unknown, resolve: () => Promise<string>, force?: boolean) => {
      const cfg = await config.readConfig();
      // The saving under test: no lock means the resolver is never invoked, so
      // an unlocked user pays no GET for an answer nobody reads.
      if (!cfg?.scopeCollectionId) return;
      await safety.checkScope(await resolve(), client, cfg, force);
    },
  );
}
