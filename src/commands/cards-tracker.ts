/**
 * `cards claim` / `cards resolve` / `cards retag` — the CLI surface of the three
 * tracker intents that had none (#63).
 *
 * They were registered on the shared dispatch table but reachable only from
 * `skill run` and MCP, so a CLI user's only route to "pick up this ticket" was
 * `cards update --assignees … --column …`: a second path, without the
 * tracker-board instance rule and without the compensation log. Every action
 * here is a thin wrapper — parse flags, dispatch, render — so the guardrails
 * stay in the one place that owns them.
 *
 * Command names deliberately equal intent names. The help topic teaches the
 * intent vocabulary, and a CLI user who reads it should not then have to guess
 * which command spells it.
 */
import { Command } from 'commander';
import { dispatch, DispatchResult } from '../lib/dispatch';
import { confirmAction } from '../lib/safety';
import { CATEGORY_TAGS, STATE_TAGS } from '../lib/tracker-config';
import { Ctx, DispatchArm, run } from '../lib/run';

const HELP_POINTER = '\nIntent contract: run `favro help issue-tracker`.';

interface TrackerFlags {
  force?: boolean;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * Everything the three actions share: the confirm, the dispatch and the result.
 *
 * Renamed from `run` in #119 — importing the command runner into this file made
 * the old name a redeclaration, and `dispatchAndReport` is what it does anyway.
 * What it no longer does is own the output or the exit code: it RETURNS the
 * dispatch arm and `run()` reports it, which is what took the three
 * `"process.exit"` string-matches out of the actions below.
 *
 * The confirmation is not decoration. Every other write in this CLI — `cards
 * link`, `cards unlink`, `cards move`, `cards update` — prompts and takes `-y`,
 * and the docs teach that trio (scope lock, `--dry-run`, confirm) as one thing.
 * Three commands that wrote straight through would make the trio a lie on
 * exactly the commands an agent reads about first. `--dry-run` skips it:
 * previewing is not writing.
 */
async function dispatchAndReport<T>(
  ctx: Ctx,
  intent: string,
  args: Record<string, unknown>,
  prompt: string,
  options: TrackerFlags,
  human: (value: T) => string,
): Promise<DispatchArm<T> | { item: { aborted: true }; human: () => string }> {
  if (!options.dryRun && !(await confirmAction(prompt, { yes: options.yes }))) {
    return { item: { aborted: true }, human: () => 'Aborted.' };
  }
  const result: DispatchResult<T> = await dispatch<T>(intent, args, {
    client: ctx.client,
    config: ctx.config,
    force: options.force,
    dryRun: options.dryRun,
  });
  return { dispatch: result, human };
}

export function registerCardsTrackerCommands(cardsCmd: Command): void {
  // ─── cards claim ───────────────────────────────────────────────────────────
  cardsCmd
    .command('claim <card>')
    .description(
      'Assign yourself to a card and move it to the tracker\'s active column, in\n' +
      'ONE call — the `claim` intent.\n\n' +
      'Acts on the tracker-board INSTANCE of the card and refuses if it is not\n' +
      'there: claiming forks a card (Favro answers an assignment write with a\n' +
      'second entity that has no board and no column), and a fork has no column to\n' +
      'be moved to. The assignment ADDS you and unassigns nobody.\n\n' +
      'Examples:\n' +
      '  favro cards claim CLA-1804\n' +
      '  favro cards claim CLA-1804 --assignee alice@example.com\n'
    )
    .option('--assignee <user>', 'Whom to assign — a name, an email, a userId or @me. Defaults to you.')
    .option('--dry-run', 'Preview the claim without writing')
    .option('--force', 'Bypass scope check')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', HELP_POINTER)
    .action(run((ctx: Ctx, card: string, options: TrackerFlags & { assignee?: string }) =>
      dispatchAndReport<{ cardId: string; columnId?: string; assignee: string }>(
        ctx,
        'claim',
        { card, assignee: options.assignee },
        `Claim card ${card}${options.assignee ? ` for ${options.assignee}` : ''}?`,
        options,
        (v) => `✓ Claimed ${v.cardId} for ${v.assignee} (column ${v.columnId ?? '—'})`,
      )));

  // ─── cards resolve ─────────────────────────────────────────────────────────
  cardsCmd
    .command('resolve <card>')
    .description(
      'Move a card to the tracker\'s done column — the `resolve` intent.\n\n' +
      'Same tracker-board instance rule as `claim`: the mapped columns belong to\n' +
      'the tracker board, so a card that is not on it is refused rather than\n' +
      'silently left where it is.\n\n' +
      'Examples:\n' +
      '  favro cards resolve CLA-1804\n'
    )
    .option('--dry-run', 'Preview the move without writing')
    .option('--force', 'Bypass scope check')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', HELP_POINTER)
    .action(run((ctx: Ctx, card: string, options: TrackerFlags) =>
      dispatchAndReport<{ cardId: string; columnId?: string }>(
        ctx,
        'resolve',
        { card },
        `Resolve card ${card}?`,
        options,
        (v) => `✓ Resolved ${v.cardId} (column ${v.columnId ?? '—'})`,
      )));

  // ─── cards retag ───────────────────────────────────────────────────────────
  cardsCmd
    .command('retag <card>')
    .description(
      'Set the triage roles on a card — exactly one category, exactly one state.\n' +
      'The `retag` intent.\n\n' +
      `Category: ${CATEGORY_TAGS.join(' | ')}\n` +
      `State:    ${STATE_TAGS.join(' | ')}\n\n` +
      'An unknown role name is REFUSED before the write: on a tag write Favro\n' +
      'reads an unknown name as a tag CREATION, not as a match. Tags outside the\n' +
      'two axes are carried through untouched — this swaps roles, it does not\n' +
      'replace the card\'s tag array. Omit an axis to keep the role already on the\n' +
      'card; if the card carries none, or more than one, it refuses and says so.\n\n' +
      'Examples:\n' +
      '  favro cards retag CLA-1804 --category bug --state ready-for-agent\n' +
      '  favro cards retag CLA-1804 --state needs-info\n'
    )
    .option('--category <role>', `Category role: ${CATEGORY_TAGS.join('|')}`)
    .option('--state <role>', `State role: ${STATE_TAGS.join('|')}`)
    .option('--dry-run', 'Preview the retag without writing')
    .option('--force', 'Bypass scope check')
    .option('-y, --yes', 'Skip confirmation prompt')
    .addHelpText('after', HELP_POINTER)
    .action(run((ctx: Ctx, card: string, options: TrackerFlags & { category?: string; state?: string }) =>
      dispatchAndReport<{ cardId: string; category: string; state: string; tags: string[] }>(
        ctx,
        'retag',
        { card, category: options.category, state: options.state },
        `Retag card ${card}?`,
        options,
        (v) => `✓ Retagged ${v.cardId}: category=${v.category} state=${v.state}`,
      )));
}

export default registerCardsTrackerCommands;
