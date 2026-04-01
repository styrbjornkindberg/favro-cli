/**
 * AI Planner — LLM-powered change planning
 *
 * Takes a natural language goal, sends board context to the LLM,
 * and generates an execution plan as ApiCall[] objects.
 * Integrates with the existing Change Store and Propose/Execute pattern.
 */
import crypto from 'crypto';
import FavroHttpClient from '../lib/http-client';
import ContextAPI, { BoardContextSnapshot } from './context';
import { AIProvider, collectCompletion } from '../lib/ai-provider';
import { buildDoPrompt, parseDoResponse } from '../lib/ai-prompt';
import { changeStore, ApiCall, TTL_MS } from '../lib/change-store';
import { ProposedAction } from './propose';

export interface AIPlanResult {
  plan: ApiCall[];
  rawResponse: string;
}

/**
 * Generate an execution plan from a natural language goal using an LLM.
 * Returns the plan as ApiCall[] plus the raw LLM response for debugging.
 */
export async function generatePlan(
  snapshot: BoardContextSnapshot,
  goal: string,
  provider: AIProvider,
): Promise<AIPlanResult> {
  const { system, user } = buildDoPrompt(snapshot, goal);

  const rawResponse = await collectCompletion(
    provider.complete(system, [{ role: 'user', content: user }], {
      temperature: 0.1,
      maxTokens: 4096,
    }),
  );

  const plan = parseDoResponse(rawResponse);
  return { plan, rawResponse };
}

/**
 * Propose a change using the AI planner.
 * Fetches board context, generates plan via LLM, stores as a proposal.
 */
export async function proposeWithAI(
  board: string,
  goal: string,
  client: FavroHttpClient,
  provider: AIProvider,
): Promise<ProposedAction> {
  const contextApi = new ContextAPI(client);
  const snapshot = await contextApi.getSnapshot(board);

  const { plan } = await generatePlan(snapshot, goal, provider);

  if (plan.length === 0) {
    return {
      changeId: '',
      boardName: snapshot.board.name,
      actionText: goal,
      preview: [],
      expiresAt: 0,
    };
  }

  const changeId = `ch_${crypto.randomBytes(8).toString('hex')}`;
  const expiresAt = Date.now() + TTL_MS;

  changeStore.storeChange(changeId, {
    changeId,
    boardName: snapshot.board.name,
    actionText: goal,
    apiCalls: plan,
    status: 'proposed',
    expiresAt,
  });

  return {
    changeId,
    boardName: snapshot.board.name,
    actionText: goal,
    preview: plan,
    expiresAt,
  };
}
