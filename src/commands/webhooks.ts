/**
 * Webhooks CLI Commands
 * CLA-1790 FAVRO-028: Implement Webhooks API
 *
 * Commands:
 *   favro webhooks list [--format table|json]
 *   favro webhooks create --event card.created|card.updated --target <url>
 *   favro webhooks delete <webhook-id>
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { FavroWebhooksAPI, VALID_WEBHOOK_EVENTS } from '../api/webhooks';

export function registerWebhooksCommand(program: Command): void {
  const webhooksCmd = program
    .command('webhooks')
    .description('Webhook management — list, create, and delete webhooks');

  // ─── webhooks list ─────────────────────────────────────────────────────────
  webhooksCmd
    .command('list')
    .description('List all configured webhooks')
    .option('--format <format>', 'Output format: table or json', 'table')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new FavroWebhooksAPI(client);

        const webhooks = await api.list();

        if (options.format === 'json') {
          console.log(JSON.stringify(webhooks, null, 2));
        } else {
          if (webhooks.length === 0) {
            console.log('No webhooks configured.');
            return;
          }
          console.log(`Found ${webhooks.length} webhook(s):`);
          const rows = webhooks.map(w => ({
            ID: w.id,
            Event: w.event,
            'Target URL': w.targetUrl.length > 50 ? w.targetUrl.slice(0, 47) + '...' : w.targetUrl,
            Created: w.createdAt ? w.createdAt.slice(0, 10) : '—',
          }));
          console.table(rows);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── webhooks create ───────────────────────────────────────────────────────
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
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          console.log(`[dry-run] Would create webhook: event=${options.event}, target=${options.target}`);
          return;
        }
        const client = await createFavroClient();
        const api = new FavroWebhooksAPI(client);

        const webhook = await api.create(options.event, options.target);
        console.log(`✓ Webhook created: ${webhook.id}`);
        console.log(`  Event:  ${webhook.event}`);
        console.log(`  Target: ${webhook.targetUrl}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

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
    .action(async (webhookId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const { confirmAction } = await import('../lib/safety');
        if (!(await confirmAction(`Delete webhook ${webhookId}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }
        
        const client = await createFavroClient();
        const api = new FavroWebhooksAPI(client);

        await api.delete(webhookId);
        console.log(`✓ Webhook deleted: ${webhookId}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerWebhooksCommand;
