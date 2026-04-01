/**
 * AI Commands
 *
 * favro ai setup        — Configure AI provider
 * favro ask <board> "q" — Ask a question about a board
 * favro do <board> "g"  — Execute a goal with AI planning
 * favro explain <cardId> — AI-generated card summary
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig, writeConfig } from '../lib/config';
import { logError } from '../lib/error-handler';
import { createAIProvider, AIConfig, collectCompletion } from '../lib/ai-provider';
import ContextAPI from '../api/context';
import { CommentsApiClient } from '../api/comments';
import CardsAPI from '../lib/cards-api';
import { buildAskPrompt, buildExplainPrompt, serializeBoardContext } from '../lib/ai-prompt';
import { generatePlan, proposeWithAI } from '../api/ai-planner';
import { executeChange } from '../api/propose';
import { confirmAction, dryRunLog } from '../lib/safety';

// ─── Helper: resolve AI provider from config ─────────────────────────────────

async function resolveProvider() {
  const config = await readConfig();
  if (!config.ai?.provider) {
    throw new Error(
      'No AI provider configured.\n' +
      '  Run `favro ai setup` to configure, or set ANTHROPIC_API_KEY / OPENAI_API_KEY env var.\n\n' +
      '  Quick start:\n' +
      '    export ANTHROPIC_API_KEY=sk-ant-...\n' +
      '    favro ai setup',
    );
  }
  return createAIProvider(config.ai);
}

// ─── favro ai setup ───────────────────────────────────────────────────────────

function registerAISetupCommand(aiCmd: Command): void {
  aiCmd
    .command('setup')
    .description('Configure AI provider for LLM-powered commands')
    .option('--provider <provider>', 'AI provider: anthropic, openai, ollama')
    .option('--model <model>', 'Model name (default depends on provider)')
    .option('--api-key <key>', 'API key for the provider')
    .option('--ollama-url <url>', 'Ollama base URL (default: http://localhost:11434)')
    .action(async (options) => {
      try {
        const config = await readConfig();

        let provider = options.provider as AIConfig['provider'] | undefined;
        if (!provider) {
          // Auto-detect from env vars
          if (process.env.ANTHROPIC_API_KEY) provider = 'anthropic';
          else if (process.env.OPENAI_API_KEY) provider = 'openai';
        }

        if (!provider) {
          console.error(
            'Please specify a provider:\n' +
            '  favro ai setup --provider anthropic --api-key sk-ant-...\n' +
            '  favro ai setup --provider openai --api-key sk-...\n' +
            '  favro ai setup --provider ollama\n\n' +
            'Or set an environment variable: ANTHROPIC_API_KEY or OPENAI_API_KEY',
          );
          process.exit(1);
        }

        const aiConfig: AIConfig = {
          provider,
          model: options.model,
          apiKey: options.apiKey,
          ollamaBaseUrl: options.ollamaUrl,
        };

        // Validate the provider can be created
        createAIProvider(aiConfig);

        config.ai = aiConfig;
        await writeConfig(config);

        console.log(`✓ AI provider configured: ${provider}${aiConfig.model ? ` (${aiConfig.model})` : ''}`);
        console.log('  Try: favro ask <board> "What cards are blocked?"');
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });
}

// ─── favro ask <board> "<question>" ──────────────────────────────────────────

function registerAskCommand(program: Command): void {
  program
    .command('ask <board> <question>')
    .description(
      'Ask an AI question about a board\n\n' +
      'Examples:\n' +
      '  favro ask "Sprint 42" "What is blocking the release?"\n' +
      '  favro ask board-123 "Summarize alice workload"\n' +
      '  favro ask board-123 "What changed recently?" --json',
    )
    .option('--json', 'Output raw JSON response')
    .option('--context-only', 'Dump the board context without calling the LLM (for debugging)')
    .option('--limit <n>', 'Max cards to include in context (default: 1000)', '1000')
    .action(async (board: string, question: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const contextApi = new ContextAPI(client);
        const cardLimit = Math.min(parseInt(options.limit ?? '1000', 10) || 1000, 5000);

        process.stderr.write('Fetching board context...\n');
        const snapshot = await contextApi.getSnapshot(board, cardLimit);

        if (options.contextOnly) {
          const { system } = buildAskPrompt(snapshot, question);
          console.log(system);
          return;
        }

        const provider = await resolveProvider();
        const { system, user } = buildAskPrompt(snapshot, question);

        if (options.json) {
          const response = await collectCompletion(
            provider.complete(system, [{ role: 'user', content: user }]),
          );
          console.log(JSON.stringify({ board: snapshot.board.name, question, answer: response }));
        } else {
          process.stderr.write('\n');
          for await (const chunk of provider.complete(system, [{ role: 'user', content: user }])) {
            process.stdout.write(chunk);
          }
          process.stdout.write('\n');
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

// ─── favro do <board> "<goal>" ───────────────────────────────────────────────

function registerDoCommand(program: Command): void {
  program
    .command('do <board> <goal>')
    .description(
      'Execute a goal on a board using AI planning\n\n' +
      'The AI generates an execution plan, previews it, and executes after confirmation.\n\n' +
      'Examples:\n' +
      '  favro do "Sprint 42" "move all overdue cards to Review"\n' +
      '  favro do board-123 "assign all unassigned bugs to alice" --dry-run\n' +
      '  favro do board-123 "triage new cards — P1 bugs to alice, others to backlog"',
    )
    .option('--dry-run', 'Show the plan without executing')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output plan as JSON')
    .action(async (board: string, goal: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const provider = await resolveProvider();
        const client = await createFavroClient();

        process.stderr.write('Analyzing board and generating plan...\n');
        const proposal = await proposeWithAI(board, goal, client, provider);

        if (proposal.preview.length === 0) {
          console.log('No changes needed — the goal is already met or could not be interpreted.');
          return;
        }

        // Show plan preview
        console.log(`\nPlan for "${proposal.boardName}" (${proposal.preview.length} operations):\n`);
        for (const call of proposal.preview) {
          console.log(`  ${call.method} ${call.path}`);
          console.log(`    → ${call.description}`);
        }

        if (options.json) {
          console.log(JSON.stringify(proposal, null, 2));
        }

        if (options.dryRun) {
          console.log('\n[dry-run] No changes made.');
          return;
        }

        if (!(await confirmAction(`Execute ${proposal.preview.length} operations on "${proposal.boardName}"?`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        process.stderr.write('\nExecuting...\n');
        const result = await executeChange(proposal.changeId, client);

        if (result.status === 'executed') {
          console.log(`\n✓ ${result.changes.filter(c => c.result === 'success').length} operations completed successfully.`);
        } else {
          console.error(`\n✗ Execution failed: ${result.message}`);
          for (const c of result.changes.filter(ch => ch.result === 'failed')) {
            console.error(`  ✗ ${c.description}: ${c.error}`);
          }
          process.exit(1);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

// ─── favro explain <cardId> ──────────────────────────────────────────────────

function registerExplainCommand(program: Command): void {
  program
    .command('explain <cardId>')
    .description(
      'AI-generated summary of a card\n\n' +
      'Examples:\n' +
      '  favro explain abc123\n' +
      '  favro explain abc123 --json',
    )
    .option('--json', 'Output raw JSON response')
    .option('--board <boardId>', 'Board context for richer analysis')
    .action(async (cardId: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const provider = await resolveProvider();
        const client = await createFavroClient();
        const cardsApi = new CardsAPI(client);
        const commentsApi = new CommentsApiClient(client);

        process.stderr.write('Fetching card details...\n');

        // Fetch card + comments in parallel
        const [card, comments] = await Promise.all([
          cardsApi.getCard(cardId),
          commentsApi.listComments(cardId, 20).catch(() => []),
        ]);

        // Build card context string
        const parts: string[] = [
          `# Card: ${card.name}`,
          `ID: ${card.cardId}`,
          card.status ? `Status: ${card.status}` : '',
          card.assignees?.length ? `Assignees: ${card.assignees.join(', ')}` : 'Assignees: none',
          card.tags?.length ? `Tags: ${card.tags.join(', ')}` : '',
          card.dueDate ? `Due: ${card.dueDate}` : 'Due: not set',
          card.description ? `\nDescription:\n${card.description}` : '',
          card.createdAt ? `Created: ${card.createdAt}` : '',
          card.updatedAt ? `Last updated: ${card.updatedAt}` : '',
        ];

        // Dependencies
        if (card.links?.length) {
          parts.push('\n## Dependencies');
          for (const link of card.links) {
            parts.push(`- ${link.type}: ${link.cardId}`);
          }
        }

        // Comments
        if (comments.length > 0) {
          parts.push(`\n## Comments (${comments.length})`);
          for (const c of comments) {
            parts.push(`- [${c.createdAt ?? 'unknown date'}] ${c.author ?? 'Unknown'}: ${c.text}`);
          }
        }

        const cardData = parts.filter(Boolean).join('\n');
        const { system, user } = buildExplainPrompt(cardData);

        if (options.json) {
          const response = await collectCompletion(
            provider.complete(system, [{ role: 'user', content: user }]),
          );
          console.log(JSON.stringify({ cardId, card: card.name, summary: response }));
        } else {
          process.stderr.write('\n');
          for await (const chunk of provider.complete(system, [{ role: 'user', content: user }])) {
            process.stdout.write(chunk);
          }
          process.stdout.write('\n');
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerAICommands(program: Command): void {
  const aiCmd = program.command('ai').description('AI provider configuration');
  registerAISetupCommand(aiCmd);

  registerAskCommand(program);
  registerDoCommand(program);
  registerExplainCommand(program);
}
