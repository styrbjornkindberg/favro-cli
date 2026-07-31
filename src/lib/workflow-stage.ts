/**
 * Workflow stage detection — the ONE home (#52).
 *
 * `detectStage` used to exist as three byte-identical copies (api/context.ts,
 * api/aggregate.ts, commands/init.ts). It is a keyword guess at what a column
 * name means, so it is demoted here to what a guess may be trusted with:
 * an **init-time proposal and display**. `claim` / `resolve` never consult it —
 * they read the two stored `columnId`s, which is why the mapping is ids.
 */

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
export function detectStage(name: string): WorkflowStage {
  const n = name.toLowerCase();

  // Done / completed / archived
  if (/done|klar|färdig|complete|closed|released|shipped|deploy|live|finished|avslut/i.test(n)) return 'done';
  if (/archived?|arkiver/i.test(n)) return 'archived';

  // Approved / accepted
  if (/approv|godkän|accept|verified|sign.?off/i.test(n)) return 'approved';

  // Active / in progress / developing — check BEFORE testing so "Developing" isn't caught by "test"
  if (/progress|develop|pågå|aktiv|doing|working|implement|bygg|coding|current/i.test(n)) return 'active';

  // Testing / QA
  if (/test|qa|kvalit|verif/i.test(n)) return 'testing';

  // Review / code review
  if (/review|gransk|feedback|pending/i.test(n)) return 'review';

  // Queued / selected / ready / next
  if (/select|vald|ready|next|sprint|priorit|planned|schedul|redo/i.test(n)) return 'queued';

  // Backlog / inbox / new / todo
  if (/backlog|inbox|new|ny|todo|to.do|icke|idea|wish|önskelista|triage|incoming/i.test(n)) return 'backlog';

  return 'queued';
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
