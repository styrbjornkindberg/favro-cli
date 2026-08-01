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
import { dispatch } from '../lib/dispatch';
import { reportDispatch } from '../lib/report-dispatch';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
import { CATEGORY_TAGS, STATE_TAGS } from '../lib/tracker-config';

const HELP_POINTER = '\nIntent contract: run `favro help issue-tracker`.';

/**
 * Everything the three actions share: a client, the config, and the flags.
 *
 * The confirmation is not decoration. Every other write in this CLI — `cards
 * link`, `cards unlink`, `cards move`, `cards update`, the bulk paths — prompts
 * and takes `-y`, and the docs teach that trio (scope lock, `--dry-run`,
 * confirm) as one thing. Three new commands that wrote straight through would
 * make the trio a lie on exactly the commands an agent reads about first.
 * `--dry-run` skips it: previewing is not writing.
 */
async function run<T>(
  intent: string,
  args: Record<string, unknown>,
  prompt: string,
  options: { force?: boolean; dryRun?: boolean; json?: boolean; yes?: boolean },
  onOk: (value: T) => void,
): Promise<void> {
  const client = await createFavroClient();
  const { readConfig } = await import('../lib/config');
  const { confirmAction } = await import('../lib/safety');
  if (!options.dryRun && !(await confirmAction(prompt, { yes: options.yes }))) {
    console.log('Aborted.');
    process.exit(0);
  }
  const result = await dispatch<T>(intent, args, {
    client,
    config: (await readConfig()) ?? {},
    force: options.force,
    dryRun: options.dryRun,
  });
  if (reportDispatch(result, options.json)) process.exit(1);
  if (result.outcome === 'ok' && result.value !== undefined) {
    onOk(result.value);
    if (options.json) console.log(JSON.stringify(result.value, null, 2));
  }
}

export function registerCardsTrackerCommands(cardsCmd: Command): void {
  const verboseOf = () => cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;

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
    .option('--json', 'Output as JSON')
    .addHelpText('after', HELP_POINTER)
    .action(async (card: string, options) => {
      try {
        await run<{ cardId: string; columnId?: string; assignee: string }>(
          'claim',
          { card, assignee: options.assignee },
          `Claim card ${card}${options.assignee ? ` for ${options.assignee}` : ''}?`,
          options,
          (v) => console.log(`✓ Claimed ${v.cardId} for ${v.assignee} (column ${v.columnId ?? '—'})`),
        );
      } catch (error) {
        if (String((error as { message?: string })?.message).startsWith('process.exit')) throw error;
        logError(error, verboseOf());
        process.exit(1);
      }
    });

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
    .option('--json', 'Output as JSON')
    .addHelpText('after', HELP_POINTER)
    .action(async (card: string, options) => {
      try {
        await run<{ cardId: string; columnId?: string }>(
          'resolve',
          { card },
          `Resolve card ${card}?`,
          options,
          (v) => console.log(`✓ Resolved ${v.cardId} (column ${v.columnId ?? '—'})`),
        );
      } catch (error) {
        if (String((error as { message?: string })?.message).startsWith('process.exit')) throw error;
        logError(error, verboseOf());
        process.exit(1);
      }
    });

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
    .option('--json', 'Output as JSON')
    .addHelpText('after', HELP_POINTER)
    .action(async (card: string, options) => {
      try {
        await run<{ cardId: string; category: string; state: string; tags: string[] }>(
          'retag',
          { card, category: options.category, state: options.state },
          `Retag card ${card}?`,
          options,
          (v) => console.log(`✓ Retagged ${v.cardId}: category=${v.category} state=${v.state}`),
        );
      } catch (error) {
        if (String((error as { message?: string })?.message).startsWith('process.exit')) throw error;
        logError(error, verboseOf());
        process.exit(1);
      }
    });
}

export default registerCardsTrackerCommands;
