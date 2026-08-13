/**
 * `favro help issue-tracker` — the tracker contract, as a real `--help` topic.
 *
 * `--help` is the single source of truth: MCP `favro_help` shells out to
 * `favro <tokens> --help`, so a skill file never reaches the primary consumer.
 * The topic is therefore carried by a real command whose help text IS the model,
 * reachable both as `favro help issue-tracker` and as `favro issue-tracker
 * --help` (which is what MCP sends).
 *
 * It is a MODEL, not a field reference. Identifier rules and composite recipes
 * are deliberately excluded — the resolver refuses with instructions of its own,
 * and the built-in skills supply the recipes on demand.
 *
 * HAND-WRITTEN ON PURPOSE. Generating it from the dispatch table was rejected:
 * a generated list of names teaches nothing a `--help` reader could not already
 * see, and the prose here is the part that carries the contract. What guards it
 * against going stale is `src/__tests__/help-topic-drift.test.ts`, which holds
 * the names below against the real table, the real `skills/builtin/`, and the
 * real command tree.
 */
import { Command } from 'commander';

/**
 * The topic body. Exported so the drift test reads exactly what a caller reads.
 *
 * Two conventions the drift test depends on, so keep them when editing:
 *   - a section header is an all-caps line at column 0;
 *   - inside INTENTS and BUILT-IN SKILLS, a named row is
 *     `  <name>` + two-or-more spaces + prose.
 */
export const ISSUE_TRACKER_TOPIC = `
ROLLBACK GUARD — READ THIS FIRST
  A multi-step write is ONE transaction and unwinds LIFO on failure, but a
  compensating write is SKIPPED when the field changed underneath us: no version
  carrier exists on this wire, so that is detected, never prevented. Three
  outcomes — 'ok'; 'rolled-back', the world is back where it started;
  'rollback-incomplete', fields left un-restored and orphans named. The outcome
  does not settle retry: read the 'retryable' field, never the outcome.

THE SCOPE LOCK, AND THE TWO GUARDS BESIDE IT
  A write that lands on a BOARD resolves it and checks it against the locked
  collection first; a batch that straddles the lock refuses whole. The INTENTS
  below take it in the shared dispatch table — the CLI, 'skill run' and MCP get
  one check; every other BOARD write (comment, task, board, column, member)
  takes it at its own call site. '--force' is the only escape hatch, and MOST
  write commands confirm ('-y' skips) and take '--dry-run', a preview not a wall.

INTENTS
  Thirteen, one call each — no chain to author. Each has a CLI spelling; the
  three IRREVERSIBLE ones — delete, move-board, add-board-instance — log no
  compensating write, so none can be a skill step: a run is ONE transaction.
  create                Card plus every composite — parent, both dependency
                        directions, column, tags, assignees — in ONE POST, so a
                        bad value leaves no card behind. CLI: cards create.
  update                Named fields, one card or an enumerated batch — a field
                        per primitive, so a field per undo. Custom fields too,
                        by customFieldId. CLI: cards update, custom-fields set.
  read                  One card, optionally with its children. Writes nothing.
                        CLI: cards get, minus the children arm.
  delete                Remove ONE board instance; other instances of the same
                        cardCommonId survive. CLI ONLY: cards delete.
  archive               Move ONE instance across the archive line. REVERSIBLE,
                        so it CAN be a skill step. CLI: cards archive/unarchive.
  claim                 Assign yourself and move to the active column, on the
                        TRACKER-BOARD instance only: assignment FORKS the card
                        into a boardless, columnless entity. CLI: cards claim.
  resolve               Move to the tracker's done column. CLI: cards resolve.
  retag                 Exactly one category role and one state role. An unknown
                        name refuses client-side: on a tag write Favro reads an
                        unknown name as a tag CREATION. CLI: cards retag.
  add-blocking-edge     Record that one card blocks another. CLI: cards link.
  remove-blocking-edge  Remove the edge between two cards. CLI: cards unlink.
  clear-blocking-edges  EVERY edge on one card, capped at 20 — over that it
                        REFUSES rather than wiping. CLI: dependencies delete-all.
  move-board            Card OFF its board and onto another; BOTH boards are
                        checked. IRREVERSIBLE: the old column is not captured.
                        CLI: cards move.
  add-board-instance    A new instance, existing ones untouched — the one write
                        allowed to make the boardless shape every other write is
                        refused on. CLI: widgets add.

THE TWO RELATIONSHIPS, AND THE ONE THAT DOES NOT EXIST
  Ordering is 'add-blocking-edge'; Favro says before/after where this CLI says
  blocks/blocked-by — one edge, two vocabularies. Hierarchy is '--parent' on
  create: same board only, 1:N. There is NO unordered "related to" — Favro cannot
  store one, so do not model it with a blocking edge or a parent; both mean
  something else and read back as what they mean.
  At most ONE edge per pair (undirected identity, directed semantics), so a pair
  holding the reverse edge can never take the forward one and reversing is
  delete-then-add. Hence the pre-read, ONE bounded GET on ONE card and never a
  graph walk: the exact edge means no write and a report saying so, the reverse
  edge refuses and names the live direction, only "neither" writes.

ERRORS AND RETRY
  A refusal is deterministic and wrote nothing: repair the call, do not repeat it.
  A failure carries 'retryable' — obey that field. A clean 'rolled-back' is still
  NOT retryable when the wire named the failure: same call, same refusal. Nor when
  the failure never reached the wire at all — a bug on our side repeats exactly.
  403 is Favro's not-found for cards, boards, columns, comments and tasklists, so
  a 403 on a READ escalates once to a wider identifier shape while a 403 on a
  WRITE never does: "403 means nothing was written" is not constructible. And
  '403 Dependency already exists' is not success.

WIRE NOTES THAT CHANGE WHAT YOU SEND
  List reads answer an envelope, '{rows, truncated?, unreachable?}', a single read
  the bare entity. 'unreachable' is ALWAYS objects — '{id, reason}', never bare
  strings — under that one key on every command that reports one.
  Card bodies are out of output by default — '--body' returns them — and '--json'
  prints THIS CLI's answer, never Favro's raw entity. Write tags BY NAME; an
  unknown name is refused, never created. Assignment is by userId and ADDED, never
  replaced; '--assignee' takes a name, an email, a userId or '@me'.
  'columns list' already carries cardCount / timeSum / estimationSum.
  Tasklist lines Favro injects into a body are PERMANENT: a read-modify-write of
  the description re-persists them as literal body text.

BUILT-IN SKILLS
  One call, not a chain: 'favro skill run <name>'. List them: 'favro skill list'.
  pick-up               Read a ticket, then claim it.
  file-blocked          Create a ticket and record what blocks it, atomically.
  unblock               Drop a blocking edge and re-triage the card it freed.
  Need a chain of your own? Author a skill ('favro skill create') rather than
  several CLI calls: a run is ONE transaction over ONE compensation log.

BULK IS ONE TRANSACTION, NOT MANY
  'cards create --csv/--bulk' and 'cards update --from-csv' dispatch the whole
  file as ONE invocation, refusing over 20 rows: row 12 failing unwinds 1-11.
`;

/**
 * Register the topic.
 *
 * A command rather than a bare `addHelpText` block, because that is what makes
 * both `favro help issue-tracker` (commander's own help command) and
 * `favro issue-tracker --help` (what MCP `favro_help` sends) print it.
 */
export function registerIssueTrackerHelp(program: Command): void {
  program
    .command('issue-tracker')
    .description(
      // No count here on purpose. The drift test holds the INTENTS section in
      // the body against the real table, but it never reads this string — so a
      // number here rots silently, and did: it still said "seven" after the
      // eighth intent landed.
      'The Favro tracker contract: the scope lock, the intents, the two\n' +
      'relationships, and what a failed write leaves behind. Read this before\n' +
      'your first write.'
    )
    .addHelpText('after', ISSUE_TRACKER_TOPIC)
    // Bare `favro issue-tracker` prints the same thing rather than doing
    // nothing: a caller who guessed the shorter spelling still gets the topic.
    .action(function (this: Command) {
      this.outputHelp();
    });
}

export default registerIssueTrackerHelp;
