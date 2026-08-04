/**
 * One judge of "done" (#98).
 *
 * `isDoneStage` replaced FIVE copies of `['done','approved','archived']` —
 * `DONE_STAGES` in `team.ts`, `stale.ts` and `health.ts`, the same three strings
 * under the name `COMPLETED_STAGES` in `my-standup.ts`, and the same three
 * inlined into a longer array in `main-menu.ts` — plus `isCompleted`'s separate
 * `COMPLETED_STATUSES` keyword list in `api/standup.ts`.
 *
 * WHY THE ARMS BELOW ARE SHAPED LIKE THIS. A doneness judge tested against a
 * single card in exactly the state being judged cannot tell a real judge from
 * `() => true`. So every test here carries a **foreign arm** (a stage that must
 * read false) and an **omit arm** (no stage at all), and the three done members
 * are asserted separately rather than as a set, so deleting any ONE of them from
 * `DONE_STAGES` fails a named assertion instead of hiding behind its siblings.
 */
import { detectStage, isDoneStage } from '../../lib/workflow-stage';
import { isCompleted } from '../../api/standup';
import type { ContextCard } from '../../api/context';

const card = (status?: string): ContextCard => ({ id: 'c1', title: 't', status }) as ContextCard;

describe('isDoneStage — the one done judge', () => {
  // Each of the three, separately. Deleting one member of DONE_STAGES kills
  // exactly one of these rather than being absorbed by the other two.
  it('counts `done`', () => {
    expect(isDoneStage('done')).toBe(true);
  });

  it('counts `approved`', () => {
    expect(isDoneStage('approved')).toBe(true);
  });

  it('counts `archived`', () => {
    expect(isDoneStage('archived')).toBe(true);
  });

  // The foreign arms. Without these, `() => true` passes everything above.
  it.each(['backlog', 'queued', 'active', 'review', 'testing'])(
    'does not count the unfinished stage `%s`',
    (stage) => {
      expect(isDoneStage(stage)).toBe(false);
    },
  );

  // The omit arms. `stale`/`health`/`team` each passed `card.stage ?? ''` and
  // `my-standup` passed a `card.stage` it had already proved defined; the merged
  // judge takes the nullable directly, so absence has to be pinned as false and
  // not as a throw. A card with no stage is a card nothing could be read about
  // (#149) — treating it as finished would report a dark board's cards as done.
  it.each([undefined, null, ''])('does not count a missing stage (%p)', (stage) => {
    expect(isDoneStage(stage)).toBe(false);
  });

  // A stage-shaped string that is not a stage. Guards against the judge being
  // rewritten as a substring match, which is what four of the copies it replaced
  // were doing one level up on column names.
  it.each(['not done', 'done-ish', 'DONE', 'undone'])(
    'is an exact stage match, not a substring match (`%s`)',
    (stage) => {
      expect(isDoneStage(stage)).toBe(false);
    },
  );
});

describe('detectStage feeds the one done judge', () => {
  // The composition `isCompleted` now performs. Pins that the two halves are
  // wired together, not merely that each works alone.
  it.each(['Done', 'Complete', 'Closed', 'Released', 'Finished', 'Resolved', 'Approved', 'Archived'])(
    'reads the column name `%s` as finished',
    (name) => {
      expect(isDoneStage(detectStage(name))).toBe(true);
    },
  );

  it.each(['Backlog', 'To Do', 'Doing', 'In Progress', 'In Review', 'Testing'])(
    'reads the column name `%s` as unfinished',
    (name) => {
      expect(isDoneStage(detectStage(name))).toBe(false);
    },
  );

  // `Resolved` came from `isCompleted`'s old keyword list and `detectStage` did
  // not have it — without it, a Jira-style board silently stopped reporting its
  // resolved cards as completed when the two judges merged.
  it('gained `Resolved` from the list it absorbed', () => {
    expect(detectStage('Resolved')).toBe('done');
  });

  // And `Unresolved` is the reason it is a lookbehind. This branch returns
  // FIRST, so a false `done` here becomes `proposeColumnMapping`'s pick and
  // `init` writes it into context.json as the board's done column.
  it('does not read `Unresolved` as done, unlike the list it absorbed', () => {
    expect(detectStage('Unresolved')).not.toBe('done');
    expect(isDoneStage(detectStage('Unresolved'))).toBe(false);
    expect(isCompleted(card('Unresolved'))).toBe(false);
  });
});

describe('the done set has exactly one definition in the tree', () => {
  // The same ratchet `detectStage` has carried since #52
  // (`tracker-init-wire.test.ts`). Five copies of these three strings is how
  // this ticket came to exist; a sixth must fail a test rather than a review.
  // CO-OCCURRENCE, NOT A LITERAL SPELLING. This asserted
  // `'approved',\s*'archived'` when it was written, which is a grep for ONE
  // spelling of the set: a sixth copy written `["done", "approved", "archived"]`
  // (double quotes) or `['approved', 'done', 'archived']` (reordered) passed it
  // untouched — both were constructed and both went undetected. Every ratchet in
  // this repo that scanned a textual proxy has eventually been proven blind to
  // exactly what it guarded, so this one asks the question it means: does any
  // non-test file other than the one home quote all three stage names?
  //
  // Measured before it was pinned: over every non-test `.ts` under `src/`, the
  // only file quoting all three is `lib/workflow-stage.ts`. A file that happens
  // to name all three for another reason would be a false positive — none exists
  // today, and one would be a fair thing to make somebody justify.
  it('holds `done`, `approved`, `archived` in one place only', async () => {
    const { execFileSync } = await import('child_process');
    const path = await import('path');
    const src = path.join(__dirname, '..', '..');

    // Drop this file and any other test: a test may quote the strings to assert
    // about them, which is not a second definition.
    const filesQuoting = (word: string): string[] =>
      execFileSync('grep', ['-rlE', `['"]${word}['"]`, src], { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .filter((f) => f && !f.includes('__tests__'));

    const approved = new Set(filesQuoting('approved'));
    const archived = new Set(filesQuoting('archived'));
    const hits = filesQuoting('done').filter((f) => approved.has(f) && archived.has(f));

    expect(hits).toEqual([path.join(src, 'lib', 'workflow-stage.ts')]);
  });

  it('exports the judge from that one place, so callers cannot re-derive it', async () => {
    const { execFileSync } = await import('child_process');
    const path = await import('path');
    const src = path.join(__dirname, '..', '..');

    const hits = execFileSync(
      'grep',
      ['-rl', 'function isDoneStage', src],
      { encoding: 'utf-8' },
    )
      .trim()
      .split('\n')
      .filter((f) => f && !f.includes('__tests__'));

    expect(hits).toEqual([path.join(src, 'lib', 'workflow-stage.ts')]);
  });
});

describe('isCompleted routes through the one judge (#98)', () => {
  // Everything the old `COMPLETED_STATUSES` list answered true, still true.
  it.each(['Done', 'done', 'Completed', 'Closed', 'Released', 'Finished', 'Resolved'])(
    'keeps `%s` completed',
    (status) => {
      expect(isCompleted(card(status))).toBe(true);
    },
  );

  // Everything it answered false, still false — the foreign arm for the merge.
  it.each(['In Progress', 'Backlog', 'To Do', 'Doing'])('keeps `%s` not completed', (status) => {
    expect(isCompleted(card(status))).toBe(false);
  });

  // The omit arm. `detectStage` falls through to `queued` on an absent name
  // rather than throwing, and `queued` is not done.
  it('is not completed when Favro sent no status', () => {
    expect(isCompleted(card(undefined))).toBe(false);
    expect(isCompleted(card(''))).toBe(false);
  });

  // The deliberate widening, asserted rather than left to be discovered. An
  // `Approved` card used to match NO standup group and be dropped from the
  // output; it is finished work and now says so.
  it.each(['Approved', 'Archived', 'Klar', 'Färdig', 'Shipped'])(
    'now counts `%s` as completed, which the old keyword list did not',
    (status) => {
      expect(isCompleted(card(status))).toBe(true);
    },
  );
});
