/**
 * `favro team` — CTO Persona: Cross-board team utilization
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { logError } from '../lib/error-handler';

const ACTIVE_STAGES = ['active', 'review', 'testing'];
const DONE_STAGES = ['done', 'approved', 'archived'];

interface TeamMember {
  name: string;
  email: string;
  activeBoards: string[];
  totalCards: number;
  wipCount: number;
  doneCount: number;
  blockedCount: number;
  completionRate: number;
  effortSum: number;
}

interface TeamResult {
  scope: string;
  members: TeamMember[];
  avgWip: number;
  bottleneck?: { name: string; blockedCount: number };
  totalMembers: number;
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

function formatHuman(data: TeamResult): string {
  const lines: string[] = [];
  lines.push(`Team — ${data.scope} (${data.totalMembers} members, avg WIP: ${data.avgWip.toFixed(1)})\n`);

  for (const m of data.members) {
    const rate = `${Math.round(m.completionRate * 100)}%`;
    lines.push(`  ${m.name} (${m.email})`);
    lines.push(`    WIP: ${m.wipCount}  Done: ${m.doneCount}  Blocked: ${m.blockedCount}  Rate: ${rate}  Effort: ${m.effortSum}`);
    lines.push(`    Boards: ${m.activeBoards.join(', ')}`);
  }

  if (data.bottleneck) {
    lines.push(`\n  Bottleneck: ${data.bottleneck.name} (${data.bottleneck.blockedCount} blocked cards)`);
  }

  return lines.join('\n');
}

export function registerTeamCommand(program: Command): void {
  program
    .command('team')
    .description('Cross-board team utilization and bottleneck analysis (LLM-first JSON)')
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
        if (options.collection) {
          snapshot = await api.getCollectionSnapshot(options.collection, cardLimit);
          scope = options.collection;
        } else if (config.scopeCollectionId) {
          snapshot = await api.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, cardLimit);
          scope = config.scopeCollectionName ?? config.scopeCollectionId;
        } else {
          snapshot = await api.getMultiBoardSnapshot({}, cardLimit);
          scope = 'all collections';
        }

        // Build per-member stats
        const memberMap = new Map<string, TeamMember>();

        for (const card of snapshot.allCards) {
          const assignees = card.assignees?.length ? card.assignees : [];
          for (const uid of assignees) {
            if (!memberMap.has(uid)) {
              const member = snapshot.members.find((m: any) => m.id === uid);
              memberMap.set(uid, {
                name: member?.name ?? uid,
                email: member?.email ?? '',
                activeBoards: [],
                totalCards: 0,
                wipCount: 0,
                doneCount: 0,
                blockedCount: 0,
                completionRate: 0,
                effortSum: 0,
              });
            }
            const tm = memberMap.get(uid)!;
            tm.totalCards++;
            tm.effortSum += extractEffort(card);

            const bName = (card as any).boardName;
            if (bName && !tm.activeBoards.includes(bName)) tm.activeBoards.push(bName);

            if (ACTIVE_STAGES.includes(card.stage ?? '')) tm.wipCount++;
            if (DONE_STAGES.includes(card.stage ?? '')) tm.doneCount++;
            if ((card.blockedBy && card.blockedBy.length > 0)) tm.blockedCount++;
          }
        }

        // Compute completion rates
        for (const [, tm] of memberMap) {
          tm.completionRate = tm.totalCards > 0 ? tm.doneCount / tm.totalCards : 0;
        }

        const members = Array.from(memberMap.values())
          .filter(m => m.name !== 'unassigned')
          .sort((a, b) => b.wipCount - a.wipCount);

        const avgWip = members.length > 0
          ? members.reduce((sum, m) => sum + m.wipCount, 0) / members.length
          : 0;

        const bottleneck = members.reduce<TeamResult['bottleneck']>((worst, m) => {
          if (!worst || m.blockedCount > worst.blockedCount) {
            return { name: m.name, blockedCount: m.blockedCount };
          }
          return worst;
        }, undefined);

        const result: TeamResult = {
          scope,
          members,
          avgWip,
          bottleneck: bottleneck && bottleneck.blockedCount > 0 ? bottleneck : undefined,
          totalMembers: members.length,
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

export default registerTeamCommand;
