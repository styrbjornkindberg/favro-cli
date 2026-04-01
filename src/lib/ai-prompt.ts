/**
 * AI Prompt Templates
 *
 * Serializes board context, card details, and action definitions into
 * structured LLM system prompts. Handles token budget management by
 * truncating card lists when the context exceeds model limits.
 */
import { BoardContextSnapshot, ContextCard } from '../api/context';
import { ApiCall } from '../lib/change-store';

// ─── Token Budget (conservative char-based estimate: ~4 chars per token) ──────

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── Board Context Serialization ──────────────────────────────────────────────

function serializeCard(card: ContextCard): string {
  const parts = [`- [${card.id}] "${card.title}"`];
  if (card.status) parts.push(`status:${card.status}`);
  if (card.owner) parts.push(`owner:${card.owner}`);
  if (card.assignees && card.assignees.length > 1) parts.push(`assignees:${card.assignees.join(',')}`);
  if (card.tags && card.tags.length) parts.push(`tags:${card.tags.join(',')}`);
  if (card.due) parts.push(`due:${card.due}`);
  if (card.blockedBy && card.blockedBy.length) parts.push(`blockedBy:${card.blockedBy.join(',')}`);
  if (card.blocking && card.blocking.length) parts.push(`blocking:${card.blocking.join(',')}`);
  if (card.customFields) {
    for (const [key, val] of Object.entries(card.customFields)) {
      if (val !== undefined && val !== null && val !== '') {
        parts.push(`${key}:${val}`);
      }
    }
  }
  return parts.join(' | ');
}

/**
 * Serialize a board snapshot into a compact text format for LLM context.
 * Truncates card list if it exceeds the token budget.
 */
export function serializeBoardContext(snapshot: BoardContextSnapshot, maxTokens?: number): string {
  const budget = (maxTokens ?? DEFAULT_MAX_CONTEXT_TOKENS) * CHARS_PER_TOKEN;

  const header = [
    `# Board: ${snapshot.board.name}`,
    snapshot.board.description ? `Description: ${snapshot.board.description}` : '',
    `ID: ${snapshot.board.id}`,
    `Type: ${snapshot.board.type ?? 'board'}`,
    '',
    `## Columns (${snapshot.columns.length})`,
    ...snapshot.columns.map(c => `- ${c.name} (${c.id})${c.cardCount !== undefined ? ` — ${c.cardCount} cards` : ''}`),
    '',
    `## Members (${snapshot.members.length})`,
    ...snapshot.members.map(m => `- ${m.name} <${m.email}>${m.role ? ` [${m.role}]` : ''} (${m.id})`),
    '',
  ].filter(Boolean).join('\n');

  const statsBlock = [
    `## Stats`,
    `Total cards: ${snapshot.stats.total}`,
    `By status: ${Object.entries(snapshot.stats.by_status).map(([k, v]) => `${k}:${v}`).join(', ')}`,
    `By owner: ${Object.entries(snapshot.stats.by_owner).map(([k, v]) => `${k}:${v}`).join(', ')}`,
    '',
  ].join('\n');

  const customFieldsBlock = snapshot.customFields.length > 0
    ? [
        `## Custom Fields (${snapshot.customFields.length})`,
        ...snapshot.customFields.map(f => `- ${f.name} (${f.type})${f.values ? `: ${f.values.join(', ')}` : ''}`),
        '',
      ].join('\n')
    : '';

  const preamble = header + customFieldsBlock + statsBlock;
  const preambleChars = preamble.length;
  const remainingBudget = budget - preambleChars - 200; // 200 chars padding

  const serializedCards = snapshot.cards.map(serializeCard);
  let cardBlock = `## Cards (${snapshot.cards.length})\n`;
  let charCount = cardBlock.length;
  let includedCount = 0;

  for (const line of serializedCards) {
    if (charCount + line.length + 1 > remainingBudget) {
      cardBlock += `\n... (${snapshot.cards.length - includedCount} more cards truncated for token budget)\n`;
      break;
    }
    cardBlock += line + '\n';
    charCount += line.length + 1;
    includedCount++;
  }

  return preamble + cardBlock;
}

// ─── System Prompts ───────────────────────────────────────────────────────────

export const SYSTEM_PROMPT_ASK = `You are an expert project management assistant analyzing a Favro board.
Answer the user's question based ONLY on the board data provided below.
Be concise and specific. Reference card titles and IDs when relevant.
If the data doesn't contain enough information to answer, say so clearly.
Do not invent or hallucinate information not present in the board data.

Format your response as clean Markdown.`;

export const SYSTEM_PROMPT_DO = `You are a project management automation assistant for Favro.
Given a board snapshot and a user's goal, generate a JSON execution plan.

You MUST respond with ONLY a valid JSON array of operations. No markdown, no explanation, no code fences.

Each operation is an object with these fields:
- "method": "POST" | "PATCH" | "DELETE"
- "path": the Favro API endpoint path (e.g., "/cards/<cardId>")
- "data": the request body (object or null)
- "description": human-readable description of what this operation does

Available operations:
- Move card to status: PATCH /cards/<cardId> with {"status": "<columnName>"}
- Assign card: PATCH /cards/<cardId> with {"addAssignmentIds": ["<userId>"]}
- Unassign card: PATCH /cards/<cardId> with {"removeAssignmentIds": ["<userId>"]}
- Update card name: PATCH /cards/<cardId> with {"name": "<newName>"}
- Add tag: PATCH /cards/<cardId> with {"addTagIds": ["<tagId>"]}
- Remove tag: PATCH /cards/<cardId> with {"removeTagIds": ["<tagId>"]}
- Set due date: PATCH /cards/<cardId> with {"dueDate": "<ISO8601>"}
- Add comment: POST /cards/<cardId>/comments with {"comment": "<text>"}
- Create card: POST /cards with {"name": "<title>", "widgetCommonId": "<boardId>"}

Rules:
- Use actual card IDs and member IDs from the board data. Never make up IDs.
- If you can't find a card or member mentioned in the goal, return an empty array [].
- Skip cards that are already in the target state.
- Return [] if the goal is unclear or impossible with the available data.`;

export const SYSTEM_PROMPT_EXPLAIN = `You are a project management assistant. Given detailed card information,
provide a clear, structured summary. Include:

1. **What**: What this card is about (one sentence)
2. **Status**: Current state and column
3. **People**: Who's assigned and involved
4. **Dependencies**: What blocks this or what this blocks
5. **Timeline**: Due date, how long it's been open, recent activity
6. **Recommendation**: Suggested next action

Be concise. Use bullet points. Reference specific details from the data.`;

// ─── Prompt Builders ──────────────────────────────────────────────────────────

export function buildAskPrompt(snapshot: BoardContextSnapshot, question: string): { system: string; user: string } {
  const context = serializeBoardContext(snapshot);
  return {
    system: SYSTEM_PROMPT_ASK + '\n\n---\n\n' + context,
    user: question,
  };
}

export function buildDoPrompt(snapshot: BoardContextSnapshot, goal: string): { system: string; user: string } {
  const context = serializeBoardContext(snapshot);
  return {
    system: SYSTEM_PROMPT_DO + '\n\n---\n\n' + context,
    user: `Goal: ${goal}\n\nGenerate the JSON execution plan.`,
  };
}

export function buildExplainPrompt(cardData: string): { system: string; user: string } {
  return {
    system: SYSTEM_PROMPT_EXPLAIN,
    user: cardData,
  };
}

/**
 * Parse the LLM response from a "do" command into ApiCall objects.
 * Handles common LLM quirks (markdown fences, extra text).
 */
export function parseDoResponse(response: string): ApiCall[] {
  // Strip markdown code fences if present
  let cleaned = response.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  // Try to find JSON array in the response
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) {
    return [];
  }

  const parsed = JSON.parse(arrayMatch[0]);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((op: any) => op.method && op.path && op.description)
    .map((op: any) => ({
      method: op.method as ApiCall['method'],
      path: op.path,
      data: op.data ?? undefined,
      description: op.description,
    }));
}
