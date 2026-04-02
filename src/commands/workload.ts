/**
 * `favro workload` — PM/PO Persona: Per-member card distribution
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { logError } from '../lib/error-handler';

const ACTIVE_STAGES = ['active', 'review', 'testing'];
const OVERLOAD_THRESHOLD = 8;

interface MemberWorkload {
  name: string;
  email: string;
  activeCards: number;
  totalCards: number;
  totalEffort: number;
  blockedCards: number;
  overloaded: boolean;
  cards: Array<{ id: string; title: string; stage?: string; board?: string }>;
}

interface WorkloadResult {
  scope: string;
  members: MemberWorkload[];
  alerts: string[];
  total: number;
  generatedAt: string;
}

function extractEffort(card: AggregateCard): number {
  if (!card.customFields) return 0;
  for (const [key, val] of Object.entries(card.customFields)) {
    if (/effort|story.?points?|points?|estimate/i.test(key)) {
      const n = Number(val);
      return isNaN(n) ? 0 : n;
    }
  }
  return 0;
}

function formatHuman(data: WorkloadResult): string {
  const lines: string[] = [];
  lines.push(`Workload — ${data.scope} (${data.total} cards)\n`);

  for (const m of data.members) {
    const flag = m.overloaded ? ' ⚠ OVERLOADED' : '';
    lines.push(`  ${m.name} (${m.email})${flag}`);
    lines.push(`    Active: ${m.activeCards}  Total: ${m.totalCards}  Effort: ${m.totalEffort}  Blocked: ${m.blockedCards}`);
  }

  if (data.alerts.length > 0) {
    lines.push('\n  Alerts:');
    for (const a of data.alerts) lines.push(`    ⚠ ${a}`);
  }

  return lines.join('\n');
}

export function registerWorkloadCommand(program: Command): void {
  program
    .command('workload')
    .description('Per-member card distribution and workload analysis (LLM-first JSON)')
    .option('--board <name>', 'Filter to a specific board')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--limit <n>', 'Max cards', '1000')
    .option('--human', 'Human-readable formatted output')
    .option('--json', 'JSON output (default)')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new AggregateAPI(client);
        const config = await readConfig();
        const cardLimit = parseInt(options.limit, 10) || 1000;

        let snapshot;
        let scope: string;
        if (options.board) {
          const ContextAPI = (await import('../api/context')).default;
          const ctx = new ContextAPI(client);
          const boardSnapshot = await ctx.getSnapshot(options.board, cardLimit);
          // Convert to aggregate format
          snapshot = {
            allCards: boardSnapshot.cards.map(c => ({
              ...c,
              boardName: boardSnapshot.board.name,
            })) as AggregateCard[],
            members: boardSnapshot.members,
          };
          scope = boardSnapshot.board.name;
        } else if (options.collection) {
          const result = await api.getCollectionSnapshot(options.collection, cardLimit);
          snapshot = result;
          scope = options.collection;
        } else if (config.scopeCollectionId) {
          const result = await api.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, cardLimit);
          snapshot = result;
          scope = config.scopeCollectionName ?? config.scopeCollectionId;
        } else {
          const result = await api.getMultiBoardSnapshot({}, cardLimit);
          snapshot = result;
          scope = 'all collections';
        }

        // Build per-member workload
        const memberMap = new Map<string, MemberWorkload>();

        for (const card of snapshot.allCards) {
          const assignees = card.assignees?.length ? card.assignees : ['unassigned'];
          for (const uid of assignees) {
            if (!memberMap.has(uid)) {
              const member = snapshot.members.find((m: any) => m.id === uid);
              memberMap.set(uid, {
                name: member?.name ?? uid,
                email: member?.email ?? '',
                activeCards: 0,
                totalCards: 0,
                totalEffort: 0,
                blockedCards: 0,
                overloaded: false,
                cards: [],
              });
            }
            const mw = memberMap.get(uid)!;
            mw.totalCards++;
            mw.totalEffort += extractEffort(card);
            if (ACTIVE_STAGES.includes(card.stage ?? '')) mw.activeCards++;
            if ((card.blockedBy && card.blockedBy.length > 0)) mw.blockedCards++;
            mw.cards.push({
              id: card.id,
              title: card.title,
              stage: card.stage,
              board: (card as any).boardName,
            });
          }
        }

        // Detect overloaded/idle
        const alerts: string[] = [];
        for (const [, mw] of memberMap) {
          if (mw.activeCards > OVERLOAD_THRESHOLD) {
            mw.overloaded = true;
            alerts.push(`${mw.name} has ${mw.activeCards} active cards (threshold: ${OVERLOAD_THRESHOLD})`);
          }
          if (mw.totalCards === 0) {
            alerts.push(`${mw.name} has no assigned cards`);
          }
        }

        const members = Array.from(memberMap.values()).sort((a, b) => b.activeCards - a.activeCards);

        const result: WorkloadResult = {
          scope,
          members,
          alerts,
          total: snapshot.allCards.length,
          generatedAt: new Date().toISOString(),
        };

        const format = resolveFormat(options);
        outputResult(result, { format }, formatHuman);
      } catch (err: any) {
        logError(err, verbose);
        process.exit(1);
      }
    });
}

export default registerWorkloadCommand;
