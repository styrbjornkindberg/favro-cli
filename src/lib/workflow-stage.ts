/**
 * Workflow stage detection — the ONE home (#52, finished in #98).
 *
 * `detectStage` used to exist as three byte-identical copies (api/context.ts,
 * api/aggregate.ts, commands/init.ts). It is a keyword guess at what a column
 * name means, so it is demoted here to what a guess may be trusted with:
 * an **init-time proposal and display**. `claim` / `resolve` never consult it —
 * they read the two stored `columnId`s, which is why the mapping is ids.
 *
 * #98 finished that consolidation rather than starting a third round elsewhere:
 * this module is now also the one home for **"does this stage mean finished"**
 * (`isDoneStage`). The set had five copies — `DONE_STAGES` in `team`, `stale`
 * and `health`, the same three strings as `COMPLETED_STAGES` in `my-standup`,
 * and inlined into a longer array in `main-menu` — and `isCompleted` in
 * `api/standup.ts` asked the same question of a column name with a keyword list
 * of its own (`COMPLETED_STATUSES`). All six call sites now route here.
 *
 * WHAT THIS MODULE IS NOT ALLOWED TO DECIDE: whether a card is **blocked**.
 * That is `judgeBlockers` in `blocking.ts` and nothing else — it is the only
 * predicate with real evidence (the tracker's mapped `done` columnId, then
 * `archived`). A keyword guess at "blocked" off a column name is a heuristic,
 * and the two that remain say so where they live (`api/standup.ts`,
 * `lib/card-predicates.ts`). See `docs/adr/0005-one-done-judge.md`.
 */
import { foldName } from './fold-name';

export type WorkflowStage =
  | 'backlog'
  | 'queued'
  | 'active'
  | 'review'
  | 'testing'
  | 'approved'
  | 'done'
  | 'archived';

/**
 * Auto-detect workflow stage from a column name using keyword matching.
 * Covers common patterns across Swedish, English, and mixed-language boards.
 */
export function detectStage(name: string | null | undefined): WorkflowStage {
  // Guarded HERE, at the shared seam, not at the four call sites: every one of
  // them (`init`, `tracker-init`, `proposeColumnMapping`, `api/context`) hands
  // over a column name straight off the wire, and Favro can send one without.
  // `name.toLowerCase()` threw a TypeError on it, which in `init` was swallowed
  // by a `catch {}` and cost that board its ENTIRE workflow — no warning,
  // exit 0. A nameless column is not evidence of any stage, so it takes the
  // same fall-through default a name matching no keyword takes.
  //
  // `foldName`, not `toLowerCase`: the keywords below are NOT all ASCII —
  // `färdig`, `godkän`, `pågå` and `önskelista` are NFC literals in this file,
  // and a Swedish column name off the wire in NFD is `a` plus a combining
  // diaeresis, which none of them match. Every Swedish column then fell
  // through to `queued`, so `proposeColumnMapping` picked the wrong active and
  // done columns and `init` wrote that guess into context.json as the board's
  // workflow (#141).
  const n = foldName(name);

  // WAITING FOR SOMEBODY — and therefore not finished (#158).
  //
  // This runs before `done`, not after, because the names it exists for pair a
  // wait word with a FINISHED word: `Pending Approval` read `approved`,
  // `Awaiting Deploy` read `done`. Both are work explicitly parked until a human
  // acts, and both were counted as finished — in `team`'s `doneCount`, `health`'s
  // flow ratio, `stale`'s skip guard, and since #98 in `standup`'s and
  // `my-standup`'s `completed` group, where a card in `Pending Approval` was
  // reported as delivered work.
  //
  // A wait word beats every later branch, so this is one line rather than a
  // guard bolted onto each of them — the same reason the branch below narrowed
  // instead of growing a lookbehind per spelling.
  //
  // ponytail: explicit wait WORDS only. `Ready to Deploy` and `To Deploy` are
  // the same mistake with no wait word in them and still read `done` — measured,
  // not overlooked. Fixing those needs a rule about anticipation prefixes
  // ("ready to", "to", "för att"), which is a bigger claim than this ticket
  // argued; make it its own change if a real board turns one up.
  if (/pending|awaiting|await|waiting|vänta/i.test(n)) return 'review';

  // Done / completed / archived
  //
  // `(?<!un)resolv` carries what `isCompleted`'s own keyword list had and this
  // one did not (#98): a Jira-style `Resolved` column. It is a lookbehind and
  // not a bare `resolv` for two separate reasons. Keeping `Unresolved` out of
  // `done` is the obvious one — but the reason it has to be fixed HERE rather
  // than left as-is is that this branch returns immediately, so a false `done`
  // becomes `proposeColumnMapping`'s pick for the board's done column and `init`
  // writes that guess into context.json. The old
  // `COMPLETED_STATUSES.some(s => status.includes(s))` did call `Unresolved`
  // completed, so this is a deliberate narrowing of the merged behaviour, not
  // an inherited bug.
  //
  // `live` is `\blive\b` and not a bare `live` because "de**live**ry" contains
  // it: `Delivery`, `Deliverables` and `Livestream` all read `done` off it, and a
  // `Deliverables` column is a list of what is owed, not a column of finished
  // work (#158). It was presumably written for a `Live` column, which still
  // matches. `delivered` is spelled out beside it — the past participle IS
  // finished work, and anchoring `live` would otherwise have silently demoted it.
  if (/done|klar|färdig|complete|closed|released|shipped|deploy|\blive\b|delivered|finished|avslut|(?<!un)resolv/i.test(n)) return 'done';
  if (/archived?|arkiver/i.test(n)) return 'archived';

  // Approved / accepted.
  //
  // `approved`, not `approv`, and `godkänd`, not `godkän` (#158): the shorter
  // stems also match `Approval` and `godkännande` — the NAME OF THE GATE, which
  // is a column of work waiting for a decision, not work that got one. Both now
  // fall to the `review` branch below, where the gate belongs.
  if (/approved|godkänd|accept|verified|sign.?off/i.test(n)) return 'approved';

  // Active / in progress / developing — check BEFORE testing so "Developing" isn't caught by "test"
  if (/progress|develop|pågå|aktiv|doing|working|implement|bygg|coding|current/i.test(n)) return 'active';

  // Testing / QA
  if (/test|qa|kvalit|verif/i.test(n)) return 'testing';

  // Review / code review — and the approval GATE, see the branch above.
  if (/review|gransk|feedback|pending|approval|godkännande/i.test(n)) return 'review';

  // Queued / selected / ready / next
  if (/select|vald|ready|next|sprint|priorit|planned|schedul|redo/i.test(n)) return 'queued';

  // Backlog / inbox / new / todo
  if (/backlog|inbox|new|ny|todo|to.do|icke|idea|wish|önskelista|triage|incoming/i.test(n)) return 'backlog';

  return 'queued';
}

/**
 * The stages that mean the work is finished.
 *
 * Typed as `WorkflowStage[]` on purpose: it is the only thing stopping a typo
 * here from becoming a set member that no column can ever detect as, which is a
 * silent `false` forever rather than a compile error.
 */
const DONE_STAGES: readonly WorkflowStage[] = ['done', 'approved', 'archived'];

/**
 * Is this stage a finished one? The ONE done judge (#98).
 *
 * Takes a `string` and not a `WorkflowStage` because every caller reads
 * `card.stage`, which is `string | undefined` — a stage that came off a
 * snapshot, not a literal. A card with NO stage is not finished: it is a card
 * nothing could be read about, and `my-standup` routes exactly that case to its
 * own `stage-unknown` group rather than letting it pass as a verdict (#149).
 */
export function isDoneStage(stage: string | null | undefined): boolean {
  return (DONE_STAGES as readonly string[]).includes(stage ?? '');
}

export interface StagedColumn {
  columnId: string;
  name: string;
}

/**
 * Propose which two columns carry open/closed, for a human to confirm at init.
 *
 * `done` is the LAST column reading as done (rightmost wins on a board with
 * several closing columns); `active` is the first reading as active, falling
 * back to the first column that is neither the done pick nor a backlog.
 * Both are overridable at init — the proposal is never re-derived later.
 */
export function proposeColumnMapping(columns: StagedColumn[]): {
  active?: StagedColumn;
  done?: StagedColumn;
} {
  const staged = columns.map((c) => ({ column: c, stage: detectStage(c.name) }));

  const done = [...staged].reverse().find((s) => s.stage === 'done')?.column ?? staged[staged.length - 1]?.column;
  const rest = staged.filter((s) => s.column.columnId !== done?.columnId);
  const active =
    rest.find((s) => s.stage === 'active')?.column ??
    rest.find((s) => s.stage !== 'backlog')?.column ??
    rest[0]?.column;

  return { active, done };
}
