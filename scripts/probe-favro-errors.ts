#!/usr/bin/env npx ts-node
/**
 * Probe the closed not-found message set — CLA #38.
 *
 * This is a SCRIPT, not a test: it talks to the live Favro API with your real
 * credentials and prints what Favro actually answers for a resource that does
 * not exist. The recognised message set in src/lib/favro-error.ts is emergent —
 * Favro documents neither the statuses nor the body format — so when a case
 * below starts printing UNRECOGNISED, that is the signal to widen the set.
 *
 * Every case is a READ with a bogus id, with ONE exception: the dependency
 * case is a DELETE, because `404 "Dependency not found"` only exists on that
 * verb. It is still inert — deleting an edge between two ids that do not exist
 * removes nothing. To reproduce the RECORDED message rather than whatever
 * Favro answers for an absent card, point it at a real card:
 *
 *   FAVRO_PROBE_CARD_ID=<a real cardId with no such edge> \
 *     npx ts-node scripts/probe-favro-errors.ts
 *
 * Run:  npx ts-node scripts/probe-favro-errors.ts
 */
import { createFavroClient } from '../src/lib/client-factory';
import { classifyFavroError, classifyThrownError } from '../src/lib/favro-error';

const BOGUS = '000000000000000000000000';

/** A real card with no edge to BOGUS, if you have one. See the header. */
const PROBE_CARD_ID = process.env.FAVRO_PROBE_CARD_ID?.trim() || BOGUS;

interface ProbeCase {
  name: string;
  path: string;
  params?: Record<string, string>;
  /** Defaults to GET. Only the dependency case departs from that. */
  method?: 'get' | 'delete';
}

const CASES: ProbeCase[] = [
  { name: 'card by cardId', path: `/cards/${BOGUS}` },
  { name: 'cards by cardCommonId', path: '/cards', params: { cardCommonId: BOGUS } },
  { name: 'comments by cardCommonId', path: '/comments', params: { cardCommonId: BOGUS } },
  { name: 'tasks by cardCommonId', path: '/tasks', params: { cardCommonId: BOGUS } },
  { name: 'widget (board) by id', path: `/widgets/${BOGUS}` },
  { name: 'columns by widgetCommonId', path: '/columns', params: { widgetCommonId: BOGUS } },
  { name: 'collection by id', path: `/collections/${BOGUS}` },
  { name: 'custom field by id', path: `/customfields/${BOGUS}` },
  { name: 'tag by id', path: `/tags/${BOGUS}` },
  { name: 'user by id', path: `/users/${BOGUS}` },
  // #58 — the by-id forms behind "Task/TaskList/Comment does not exist". The
  // collection forms above answer differently and do not cover these.
  { name: 'task by id', path: `/tasks/${BOGUS}` },
  { name: 'tasklist by id', path: `/tasklists/${BOGUS}` },
  { name: 'comment by id', path: `/comments/${BOGUS}` },
  // #58 via #68 — "Dependency not found". DELETE, and inert: see the header.
  {
    name: 'dependency edge (DELETE)',
    path: `/cards/${PROBE_CARD_ID}/dependencies/${BOGUS}`,
    method: 'delete',
  },
  // #58 — the READ half of the same endpoint family. `getCardLinks`
  // (`cards-api.ts:705`) routes this through the generic `escalateOnNotFound`,
  // so if the GET can also answer "Dependency not found" the classification
  // change turns a throw into an escalating retry inside `TxCards.liveEdge` —
  // the pre-read for `removeBlockingEdge`. Probe it, do not assume.
  { name: 'card dependencies (GET)', path: `/cards/${PROBE_CARD_ID}/dependencies` },
];

async function probe(client: Awaited<ReturnType<typeof createFavroClient>>, probeCase: ProbeCase) {
  const axiosClient = client.getClient();
  try {
    const response = await axiosClient.request({
      method: probeCase.method ?? 'get',
      url: probeCase.path,
      params: probeCase.params,
    });
    // A 2xx can still carry a denial message — classify it anyway.
    return {
      status: response.status,
      classification: classifyFavroError(response.status, (response.data as any)?.message),
    };
  } catch (error: any) {
    return {
      status: error?.response?.status,
      classification: classifyThrownError(error),
    };
  }
}

async function main(): Promise<void> {
  const client = await createFavroClient();

  for (const probeCase of CASES) {
    const { status, classification } = await probe(client, probeCase);
    const raw = classification?.raw ?? '(no message)';
    const kind = classification?.kind ?? 'no-response';
    const flag = kind === 'not-found' ? 'recognised' : 'UNRECOGNISED';
    console.log(`${probeCase.name.padEnd(28)} ${String(status ?? '-').padEnd(4)} ${kind.padEnd(12)} ${flag.padEnd(13)} ${raw}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
