/**
 * `favro team` — CTO Persona: Cross-board team utilization
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { extractEffort } from '../api/context';
import { excludeUnreadableBoards, parseLimit, Unreachable } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';

const ACTIVE_STAGES = ['active', 'review', 'testing'];
const DONE_STAGES = ['done', 'approved', 'archived'];

interface TeamMember {
  name: string;
  email: string;
  activeBoards: string[];
  totalCards: number;
  wipCount: number;
  doneCount: number;
  /**
   * Cards carrying at least one dependency edge. An edge count, not a blocked
   * count — nothing clears a Favro edge when the blocker finishes, and this
   * path does not pay for `judgeBlockers` (#61).
   */
  dependencyCount: number;
  completionRate: number;
  effortSum: number;
}

interface TeamResult {
  scope: string;
  members: TeamMember[];
  avgWip: number;
  /** The member carrying the most dependency edges — see `TeamMember.dependencyCount`. */
  bottleneck?: { name: string; dependencyCount: number };
  totalMembers: number;
  /**
   * Parts of the read that failed, and therefore cards no member's counts
   * include (#148). Present only when non-empty.
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

function formatHuman(data: TeamResult): string {
  const lines: string[] = [];
  lines.push(`Team — ${data.scope} (${data.totalMembers} members, avg WIP: ${data.avgWip.toFixed(1)})\n`);

  for (const m of data.members) {
    const rate = `${Math.round(m.completionRate * 100)}%`;
    lines.push(`  ${m.name} (${m.email})`);
    lines.push(`    WIP: ${m.wipCount}  Done: ${m.doneCount}  Deps: ${m.dependencyCount}  Rate: ${rate}  Effort: ${m.effortSum}`);
    lines.push(`    Boards: ${m.activeBoards.join(', ')}`);
  }

  if (data.bottleneck) {
    lines.push(`\n  Bottleneck: ${data.bottleneck.name} (${data.bottleneck.dependencyCount} cards with dependencies)`);
  }

  // Off `unreachable` itself — human mode must not go quiet on a hole the JSON
  // reports (#117).
  if (data.unreachable?.length) {
    lines.push(`\n  ⚠️  Not counted — ${data.unreachable.length} part(s) of this scope could not be read:`);
    for (const hole of data.unreachable) lines.push(`     ${hole.id} — ${hole.reason}`);
  }

  return lines.join('\n');
}

interface TeamOptions {
  collection?: string;
  limit: string;
}

export async function teamHandler(ctx: Ctx, options: TeamOptions) {
  const cardLimit = parseLimit(options.limit) ?? 1000;

  let snapshot;
  let scope: string;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection, cardLimit);
    scope = options.collection;
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] }, cardLimit);
    scope = ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId;
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({}, cardLimit);
    scope = 'all collections';
  }

  // What a hole does to `team`: same rule as `workload` — the unreadable
  // board's cards are dropped and the hole is named, no exit code, because
  // `team` states no verdict either.
  //
  // `wipCount`, `doneCount` and `completionRate` all gate on `card.stage`, and
  // `avgWip`/`bottleneck` are derived from them. A board with no columns would
  // have contributed cards with no stage, i.e. every one of its members read as
  // 0 WIP, 0 done, 0% completion — a specific claim about a person's workload,
  // manufactured from a failed HTTP call.
  const { cards: readableCards, unreachable } = excludeUnreadableBoards(snapshot);

  // Build per-member stats
  const memberMap = new Map<string, TeamMember>();

  for (const card of readableCards) {
    const assignees = card.assignees?.length ? card.assignees : [];
    for (const uid of assignees) {
      if (!memberMap.has(uid)) {
        const member = snapshot.members.find(m => m.id === uid);
        memberMap.set(uid, {
          name: member?.name ?? uid,
          email: member?.email ?? '',
          activeBoards: [],
          totalCards: 0,
          wipCount: 0,
          doneCount: 0,
          dependencyCount: 0,
          completionRate: 0,
          effortSum: 0,
        });
      }
      const tm = memberMap.get(uid)!;
      tm.totalCards++;
      tm.effortSum += extractEffort(card) ?? 0;

      const bName = card.boardName;
      if (bName && !tm.activeBoards.includes(bName)) tm.activeBoards.push(bName);

      if (ACTIVE_STAGES.includes(card.stage ?? '')) tm.wipCount++;
      if (DONE_STAGES.includes(card.stage ?? '')) tm.doneCount++;
      if ((card.blockedBy && card.blockedBy.length > 0)) tm.dependencyCount++;
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
    if (!worst || m.dependencyCount > worst.dependencyCount) {
      return { name: m.name, dependencyCount: m.dependencyCount };
    }
    return worst;
  }, undefined);

  const result: TeamResult = {
    scope,
    members,
    avgWip,
    bottleneck: bottleneck && bottleneck.dependencyCount > 0 ? bottleneck : undefined,
    totalMembers: members.length,
    ...(unreachable.length > 0 ? { unreachable } : {}),
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerTeamCommand(program: Command): void {
  program
    .command('team')
    .description('Cross-board team utilization and bottleneck analysis (LLM-first JSON)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--limit <n>', 'Max cards', '1000')
    .action(run(teamHandler));
}

export default registerTeamCommand;
