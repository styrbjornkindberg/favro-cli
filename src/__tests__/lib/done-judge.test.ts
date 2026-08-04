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
import { detectStage, isDoneStage, proposeColumnMapping } from '../../lib/workflow-stage';
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

/**
 * #158 — the two inherited misreads, and the names that must NOT move with them.
 *
 * BOTH POLARITIES, ALWAYS PAIRED. A test that only asserts `Pending Approval` is
 * not done passes for a `detectStage` that returns `'backlog'` for every name on
 * earth, which is the unfalsifiable shape this repo keeps shipping. So each arm
 * below pins the name that changed AND the sibling that must not, and pins the
 * exact stage rather than only its doneness — `not.toBe('done')` is satisfied by
 * `'approved'`, which is the very bug.
 *
 * Measured over 87 column names before and after: exactly ten verdicts move, all
 * ten listed here or in the propose arm below.
 */
describe('a column that is waiting is not a column that is finished (#158)', () => {
  // Each separately, because they take three different routes through the ladder
  // — `pending` and `awaiting` hit the new wait branch, `Approval` reaches the
  // `review` branch only because `approv` was narrowed to `approved`. Grouping
  // them into one `it.each` would let any two cover for the third.
  it('reads `Pending Approval` as review, not as approved', () => {
    expect(detectStage('Pending Approval')).toBe('review');
    expect(isDoneStage(detectStage('Pending Approval'))).toBe(false);
    expect(isCompleted(card('Pending Approval'))).toBe(false);
  });

  it('reads `Awaiting Approval` as review', () => {
    expect(detectStage('Awaiting Approval')).toBe('review');
    expect(isDoneStage(detectStage('Awaiting Approval'))).toBe(false);
  });

  it('reads the Swedish gate `Väntar på godkännande` as review', () => {
    expect(detectStage('Väntar på godkännande')).toBe('review');
    expect(isDoneStage(detectStage('Väntar på godkännande'))).toBe(false);
  });

  // The gate NAMED, with no wait word at all. This is what the `approv` →
  // `approved` and `godkän` → `godkänd` narrowings buy, and it is why they are not
  // redundant with the wait branch above: restore either stem and these two go
  // back to reading `approved`, while every wait-worded name above still passes.
  it('reads the bare gate `Approval` as review, not as approved', () => {
    expect(detectStage('Approval')).toBe('review');
    expect(isDoneStage(detectStage('Approval'))).toBe(false);
  });

  it('reads the bare Swedish gate `Godkännande` as review, not as approved', () => {
    expect(detectStage('Godkännande')).toBe('review');
    expect(isDoneStage(detectStage('Godkännande'))).toBe(false);
  });

  // A wait word paired with a DONE word, not an APPROVED one. Kills the
  // wait branch being moved back below `done`, which would leave this at `done`
  // while every assertion above still passed.
  it('reads `Awaiting Deploy` as review, though `Deploy` alone is done', () => {
    expect(detectStage('Awaiting Deploy')).toBe('review');
    expect(detectStage('Deploy')).toBe('done');
  });

  // THE POLARITY ARM. Deleting `approved` from the approved branch, or moving the
  // wait branch above nothing at all, has to fail here.
  it.each(['Approved', 'Godkänd', 'Accepted', 'Verified', 'Sign-off'])(
    'still reads the decided `%s` as approved, and approved is finished',
    (name) => {
      expect(detectStage(name)).toBe('approved');
      expect(isDoneStage(detectStage(name))).toBe(true);
    },
  );

  // `Pending` on its own was already `review` before #158 and must stay there:
  // the new branch returns `review` too, so a mutation that deletes the ENTIRE
  // wait branch is invisible to this one. It is here as the no-change control,
  // not as a kill.
  it('leaves plain `Pending` where it already was', () => {
    expect(detectStage('Pending')).toBe('review');
  });
});

describe('`live` is a word, not a substring of "delivery" (#158)', () => {
  // Separately again: `Delivery` and `Deliverables` differ only in suffix, but
  // `Livestream` reaches the same bug from the other side of the string, so a
  // half-fix that anchored only the left edge would still pass two of the three.
  it.each(['Delivery', 'Deliverables', 'Livestream'])(
    'does not read `%s` as finished work',
    (name) => {
      expect(detectStage(name)).toBe('queued');
      expect(isDoneStage(detectStage(name))).toBe(false);
      expect(isCompleted(card(name))).toBe(false);
    },
  );

  // THE POLARITY ARM, and the reason `delivered` is spelled out in the pattern:
  // anchoring `live` without it demotes real finished work, and `not.toBe('done')`
  // on the three names above cannot see that happen.
  it.each(['Live', 'Go Live', 'Delivered', 'Released', 'Shipped'])(
    'still reads `%s` as done',
    (name) => {
      expect(detectStage(name)).toBe('done');
      expect(isDoneStage(detectStage(name))).toBe(true);
    },
  );
});

describe('what the #158 narrowing does to `init`\'s proposed done column', () => {
  const col = (name: string) => ({ columnId: name.toLowerCase().replace(/\s+/g, '-'), name });

  // `proposeColumnMapping` matches `stage === 'done'` EXACTLY, not `isDoneStage`,
  // so the `Pending Approval` half of #158 never reached it — `approved` was
  // never a candidate. Pinned because that is the claim the ticket asked to be
  // traced, and it is the difference between the two halves' blast radius.
  it('never proposed an approved column as done, so the gate fix cannot move it', () => {
    const columns = [col('Backlog'), col('Doing'), col('Pending Approval'), col('Done')];
    expect(proposeColumnMapping(columns).done?.name).toBe('Done');
    expect(proposeColumnMapping(columns).active?.name).toBe('Doing');
  });

  // The `live` half DID reach it. `Delivery` used to read `done`, and the pick is
  // the RIGHTMOST done-reading column, so it beat a real `Done` to its left.
  it('no longer prefers a rightmost `Delivery` over a real `Done`', () => {
    const columns = [col('Backlog'), col('Done'), col('Delivery')];
    expect(proposeColumnMapping(columns).done?.name).toBe('Done');
  });

  // …and where `Delivery` was the ONLY done-reading column, the pick does not
  // move: nothing reads `done` now, and the last-column fallback lands on the
  // same column the old regex picked. This is the arm that says `favro init`
  // proposes the same mapping as before for that board shape.
  it('still proposes the last column when `Delivery` was the only candidate', () => {
    const columns = [col('Backlog'), col('Doing'), col('Delivery')];
    expect(proposeColumnMapping(columns).done?.name).toBe('Delivery');
    expect(proposeColumnMapping(columns).active?.name).toBe('Doing');
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
