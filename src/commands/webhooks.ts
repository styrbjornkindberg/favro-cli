/**
 * Webhooks CLI Commands
 * CLA-1790 FAVRO-028: Implement Webhooks API
 *
 * Commands:
 *   favro webhooks list [--human]
 *   favro webhooks create --event card.created|card.updated --target <url>
 *   favro webhooks delete <webhook-id>
 */
import { Command } from 'commander';
import { VALID_WEBHOOK_EVENTS, Webhook } from '../api/webhooks';
import { confirmAction } from '../lib/safety';
import { Ctx, run } from '../lib/run';

export function registerWebhooksCommand(program: Command): void {
  const webhooksCmd = program
    .command('webhooks')
    .description('Webhook management — list, create, and delete webhooks');

  // ─── webhooks list ─────────────────────────────────────────────────────────
  webhooksCmd
    .command('list')
    .description('List all configured webhooks')
    // `--format table|json` is gone (ADR-0002, #116) — a third spelling of the
    // axis `--human` already owns.
    .action(run(async (ctx: Ctx) => ({
      rows: await ctx.api.webhooks.list(),
      human: (rows: Webhook[]) => {
        if (rows.length === 0) {
          console.log('No webhooks configured.');
          return;
        }
        console.log(`Found ${rows.length} webhook(s):`);
        console.table(rows.map(w => ({
          ID: w.id,
          Event: w.event,
          'Target URL': w.targetUrl.length > 50 ? w.targetUrl.slice(0, 47) + '...' : w.targetUrl,
          Created: w.createdAt ? w.createdAt.slice(0, 10) : '—',
        })));
      },
    })));

  // ─── webhooks create ───────────────────────────────────────────────────────
  // No scope-lock check on create or delete below, decided under #104. The lock
  // is a COLLECTION lock: `assertScope` (src/lib/safety.ts) resolves the board a
  // write lands on and asks whether it is in the locked collection. A webhook is
  // registered against the organization, not a board — there is no board to
  // resolve, so a check here would be either permanently green (a lie) or
  // permanently red. Org-scoped writes want an org-level lock, which we do not
  // have; borrowing the collection lock to stand in for one would only make the
  // lock dishonest. `confirmAction` on delete is the guard these paths do have.
  webhooksCmd
    .command('create')
    .description(
      `Create a new webhook.\n\n` +
      `Valid events: ${VALID_WEBHOOK_EVENTS.join(', ')}\n\n` +
      `Examples:\n` +
      `  favro webhooks create --event card.created --target https://example.com/webhook\n` +
      `  favro webhooks create --event card.updated --target https://api.example.com/hooks`
    )
    .requiredOption('--event <event>', `Event type (${VALID_WEBHOOK_EVENTS.join('|')})`)
    .requiredOption('--target <url>', 'Target URL for webhook delivery (HTTP or HTTPS)')
    .option('--dry-run', 'Print what would be created without making API calls')
    .action(run(async (ctx: Ctx, options: { event: string; target: string; dryRun?: boolean }) => {
      // A preview is still an ANSWER, so it is returned rather than printed and
      // returned as `void`: JSON mode gets a parseable object instead of a
      // prose line an agent has to guess at (ADR-0002).
      if (options.dryRun) {
        return {
          item: { dryRun: true, event: options.event, targetUrl: options.target },
          human: () =>
            `[dry-run] Would create webhook: event=${options.event}, target=${options.target}`,
        };
      }

      return {
        item: await ctx.api.webhooks.create(options.event as never, options.target),
        human: (webhook: Webhook) =>
          `✓ Webhook created: ${webhook.id}\n` +
          `  Event:  ${webhook.event}\n` +
          `  Target: ${webhook.targetUrl}`,
      };
    }));

  // ─── webhooks delete ───────────────────────────────────────────────────────
  webhooksCmd
    .command('delete <webhook-id>')
    .description(
      'Delete a webhook by ID.\n\n' +
      'Examples:\n' +
      '  favro webhooks delete <webhook-id>\n\n' +
      'Tip: Use `favro webhooks list` to find webhook IDs.'
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(run(async (ctx: Ctx, webhookId: string, options: { yes?: boolean }) => {
      if (!(await confirmAction(`Delete webhook ${webhookId}?`, { yes: options.yes }))) {
        // Declining is a legitimate outcome, not a failure: exit 0, and say so
        // in a shape a caller can read rather than the bare word "Aborted."
        return { item: { deleted: false, aborted: true, webhookId }, human: () => 'Aborted.' };
      }

      await ctx.api.webhooks.delete(webhookId);
      return {
        item: { deleted: true, webhookId },
        human: () => `✓ Webhook deleted: ${webhookId}`,
      };
    }));
}

export default registerWebhooksCommand;
