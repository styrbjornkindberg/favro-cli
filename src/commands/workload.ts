/**
 * `favro workload` — PM/PO Persona: Per-member card distribution
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { AggregateCard } from '../api/aggregate';
import { extractEffort } from '../api/context';
import { Ctx, run } from '../lib/run';

const ACTIVE_STAGES = ['active', 'review', 'testing'];
const OVERLOAD_THRESHOLD = 8;

export interface MemberWorkload {
  name: string;
  email: string;
  activeCards: number;
  totalCards: number;
  totalEffort: number;
  /**
   * Cards carrying at least one dependency edge. An edge count, not a blocked
   * count — nothing clears a Favro edge when the blocker finishes, and this
   * path does not pay for `judgeBlockers` (#61).
   */
  dependencyCards: number;
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

/**
 * Per-member rollup. Lifted out of the commander action so the threshold and the
 * alert wording are reachable from a test — the previous coverage lived entirely
 * in the action and amounted to `expect(9 > 8).toBe(true)` (#76).
 *
 * `members` is the snapshot member list; both the board and the aggregate paths
 * hand over the same `{ id, name, email, role? }` shape.
 */
export function buildWorkloads(
  cards: AggregateCard[],
  members: Array<{ id: string; name: string; email: string; role?: string }>,
): { members: MemberWorkload[]; alerts: string[] } {
  const memberMap = new Map<string, MemberWorkload>();

  for (const card of cards) {
    const assignees = card.assignees?.length ? card.assignees : ['unassigned'];
    for (const uid of assignees) {
      if (!memberMap.has(uid)) {
        const member = members.find(m => m.id === uid);
        memberMap.set(uid, {
          name: member?.name ?? uid,
          email: member?.email ?? '',
          activeCards: 0,
          totalCards: 0,
          totalEffort: 0,
          dependencyCards: 0,
          overloaded: false,
          cards: [],
        });
      }
      const mw = memberMap.get(uid)!;
      mw.totalCards++;
      mw.totalEffort += extractEffort(card) ?? 0;
      if (ACTIVE_STAGES.includes(card.stage ?? '')) mw.activeCards++;
      if ((card.blockedBy && card.blockedBy.length > 0)) mw.dependencyCards++;
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

  return {
    members: Array.from(memberMap.values()).sort((a, b) => b.activeCards - a.activeCards),
    alerts,
  };
}

function formatHuman(data: WorkloadResult): string {
  const lines: string[] = [];
  lines.push(`Workload — ${data.scope} (${data.total} cards)\n`);

  for (const m of data.members) {
    const flag = m.overloaded ? ' ⚠ OVERLOADED' : '';
    lines.push(`  ${m.name} (${m.email})${flag}`);
    lines.push(`    Active: ${m.activeCards}  Total: ${m.totalCards}  Effort: ${m.totalEffort}  Deps: ${m.dependencyCards}`);
  }

  if (data.alerts.length > 0) {
    lines.push('\n  Alerts:');
    for (const a of data.alerts) lines.push(`    ⚠ ${a}`);
  }

  return lines.join('\n');
}

interface WorkloadOptions {
  board?: string;
  collection?: string;
  limit: string;
}

export async function workloadHandler(ctx: Ctx, options: WorkloadOptions) {
  const cardLimit = parseInt(options.limit, 10) || 1000;

  let snapshot;
  let scope: string;
  if (options.board) {
    // `ctx.api.context` replaces the dynamic `await import` + `new ContextAPI`
    // this arm used to do; the namespace getter is lazy, so the board arm is
    // still the only path that constructs it.
    const boardSnapshot = await ctx.api.context.getSnapshot(options.board, cardLimit);
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
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection, cardLimit);
    scope = options.collection;
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] }, cardLimit);
    scope = ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId;
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({}, cardLimit);
    scope = 'all collections';
  }

  const { members, alerts } = buildWorkloads(snapshot.allCards, snapshot.members);

  const result: WorkloadResult = {
    scope,
    members,
    alerts,
    total: snapshot.allCards.length,
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerWorkloadCommand(program: Command): void {
  program
    .command('workload')
    .description('Per-member card distribution and workload analysis (LLM-first JSON)')
    .option('--board <name>', 'Filter to a specific board')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--limit <n>', 'Max cards', '1000')
    .action(run(workloadHandler));
}

export default registerWorkloadCommand;
