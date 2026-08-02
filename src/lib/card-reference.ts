/**
 * Card identifier resolution (#40).
 *
 * A card-shaped argument accepts any of the three identifiers a caller might
 * actually hold — a `sequentialId` label (`CLA-1804`), a `cardId`, or a
 * `cardCommonId` — and this module translates to whichever one the endpoint
 * being called consumes. Path segments take `cardId`; comments, tasks and
 * tasklists take `cardCommonId` in a query or body and never as a path
 * segment.
 *
 * Detection is shape-first: a `sequentialId` label is unmistakable, and the
 * other two share one keyspace syntax (24-char hex), so a hex string is
 * assumed to already be the shape the path wants and escalated only on a
 * classified not-found.
 *
 * Resolution is bounded — a fixed number of sequential calls, never a
 * per-item loop and never a fan-out.
 */
import FavroHttpClient from './http-client';
import { classifyThrownError } from './favro-error';
import { MISSING_WORDING } from './favro-error';
import { RefusalError } from './refusal';

/** A card as the resolver needs to see it — the wire shape, not a normalized Card. */
export interface CardInstance {
  cardId: string;
  cardCommonId?: string;
  widgetCommonId?: string;
  columnId?: string;
  name?: string;
  sequentialId?: number;
  [key: string]: unknown;
}

/**
 * A refusal a caller can act on: what could not be settled, which candidates
 * exist, and the exact flag that disambiguates. Never a prose guess.
 */
export class CardResolutionError extends RefusalError {
  constructor(
    message: string,
    readonly reference: string,
    readonly candidates: CardInstance[] = [],
    readonly disambiguateWith?: string,
  ) {
    super(message);
    this.name = 'CardResolutionError';
  }
}

/**
 * `CLA-1804`, `Squ-8850`, or a bare `8850`. The prefix is not an API field —
 * Favro derives it from the collection name and renders it capitalised, which
 * is what separates a label from a hyphenated id: the prefix must start with a
 * capital. A lowercase `cla-1804` is read as an id, fails to resolve, and
 * refuses with the case note below rather than guessing.
 */
const SEQUENTIAL_LABEL = /^([A-Z][A-Za-z0-9]{0,9})-(\d+)$/;
const BARE_SEQUENTIAL = /^\d+$/;

export function isSequentialReference(reference: string): boolean {
  const ref = reference.trim();
  return SEQUENTIAL_LABEL.test(ref) || BARE_SEQUENTIAL.test(ref);
}

/** The number Favro's `cardSequentialId` filter wants, or undefined. */
export function sequentialNumber(reference: string): number | undefined {
  const ref = reference.trim();
  const labelled = ref.match(SEQUENTIAL_LABEL);
  if (labelled) return parseInt(labelled[2], 10);
  if (BARE_SEQUENTIAL.test(ref)) return parseInt(ref, 10);
  return undefined;
}

/**
 * A forked card — an assignment entity with no `widgetCommonId` — has no
 * column and is unactionable by construction, so it never takes part in
 * resolution.
 */
function boardInstances(entities: CardInstance[]): CardInstance[] {
  return entities.filter((e) => Boolean(e.widgetCommonId));
}

function describe(instance: CardInstance): string {
  const board = instance.widgetCommonId ?? 'no board';
  return `${instance.cardId} (board ${board}${instance.name ? `, "${instance.name}"` : ''})`;
}

/**
 * The `cardCommonId` off a card we successfully read, or a refusal (#89).
 *
 * Both branches of `toCardCommonId` used to fall back to the reference here.
 * That is the one wrong answer these endpoints cannot report: they take
 * `cardCommonId` as a query or body value, never a path segment, so a `cardId`
 * substituted into that slot is a *well-formed* request for a card that does
 * not exist — a read comes back empty and a write lands nowhere, neither of
 * them as an error. `cardCommonId` is a documented field of the Card object, so
 * a card that arrived without one is off-contract; the honest move is to say so
 * rather than issue the call anyway. See `docs/research/card-identifier-semantics.md`
 * §3.2, which reached the same conclusion and is where the fallback was first
 * written up as a defect.
 */
function commonIdOf(instance: CardInstance, reference: string): string {
  if (instance.cardCommonId) return instance.cardCommonId;
  throw new CardResolutionError(
    `Card "${reference}" came back with no cardCommonId, which comments, tasks and tasklists require. ` +
      'Favro documents it on every card, so this is a wire-shape surprise rather than a bad reference — ' +
      're-run with --verbose and report what /cards returned.',
    reference,
    [instance],
  );
}

export class CardReferenceResolver {
  constructor(private client: FavroHttpClient) {}

  /**
   * Resolve any card reference to a single board instance.
   *
   * @param reference `CLA-1804`, a `cardId` or a `cardCommonId`.
   * @param options `widgetCommonId` narrows a card that lives on several boards.
   */
  async resolve(reference: string, options?: { widgetCommonId?: string }): Promise<CardInstance> {
    const ref = reference.trim();
    const sequential = sequentialNumber(ref);
    if (sequential !== undefined) {
      return this.pickOne(
        ref,
        await this.query({ cardSequentialId: sequential, ...options }),
        '--board <board>',
      );
    }
    return this.escalate(ref, options);
  }

  /**
   * The `cardId` a path segment wants.
   *
   * Shape-first and free on the common path: a hex reference is *assumed* to
   * already be a `cardId` and costs no call. It is only when the endpoint
   * answers a classified not-found that the other keyspace with that same
   * syntax — `cardCommonId` — is worth a lookup. See `escalateOnNotFound`.
   */
  async toCardId(reference: string, options?: { widgetCommonId?: string }): Promise<string> {
    const ref = reference.trim();
    if (!isSequentialReference(ref)) return ref;
    return (await this.resolve(ref, options)).cardId;
  }

  /**
   * Run a call that consumes a `cardId`, and retry it exactly once against the
   * escalated id if Favro answers a classified not-found.
   *
   * Escalation is confined to this read-shaped lookup: the retry only happens
   * after a not-found, which is the one answer that means "nothing was
   * written". A permission 403 never escalates.
   */
  async escalateOnNotFound<T>(
    reference: string,
    call: (cardId: string) => Promise<T>,
    options?: { widgetCommonId?: string },
  ): Promise<T> {
    const cardId = await this.toCardId(reference, options);
    try {
      return await call(cardId);
    } catch (err) {
      const classification = classifyThrownError(err);
      if (!classification?.escalatableOnRead || isSequentialReference(reference)) throw err;
      const instance = await this.escalate(reference.trim(), options);
      return call(instance.cardId);
    }
  }

  /** Read the card behind a reference that did not work as a `cardId`. */
  private async escalate(
    ref: string,
    options?: { widgetCommonId?: string },
  ): Promise<CardInstance> {
    return this.pickOne(ref, await this.query({ cardCommonId: ref, ...options }), '--board <board>');
  }

  /**
   * The `cardCommonId` that comments, tasks and tasklists want.
   *
   * A hex reference costs one card read: if it resolves as a `cardId` its
   * `cardCommonId` is authoritative, and if it is a classified not-found then
   * the reference is already a `cardCommonId` and passes through. Those
   * endpoints answer an empty list rather than an error for the wrong shape,
   * so the shape has to be settled before the call, not after it.
   */
  async toCardCommonId(reference: string, options?: { widgetCommonId?: string }): Promise<string> {
    const ref = reference.trim();
    if (!isSequentialReference(ref)) {
      try {
        const card = await this.client.get<CardInstance>(`/cards/${encodeURIComponent(ref)}`);
        return commonIdOf(card, ref);
      } catch (err) {
        const classification = classifyThrownError(err);
        if (!classification?.escalatableOnRead) throw err;
        // Not a `cardId`, so it is already a `cardCommonId`.
        return ref;
      }
    }
    return commonIdOf(await this.resolve(ref, options), ref);
  }

  private async query(params: Record<string, unknown>): Promise<CardInstance[]> {
    const response = await this.client.get<{ entities?: CardInstance[] }>('/cards', {
      params: { unique: true, ...params },
    });
    return response.entities ?? [];
  }

  /**
   * Exactly one actionable instance, or a structured refusal. Genuine
   * multi-board ambiguity is never resolved by taking `entities[0]`.
   */
  private pickOne(reference: string, entities: CardInstance[], flag: string): CardInstance {
    const instances = boardInstances(entities);
    if (instances.length === 1) return instances[0];
    if (instances.length === 0) {
      throw new CardResolutionError(
        `Card "${reference}" is ${MISSING_WORDING}. A sequentialId label is capitalised (CLA-1804); otherwise run \`favro cards list --board <board>\` to see what is there.`,
        reference,
      );
    }
    const listed = instances.map((i) => `  ${describe(i)}`).join('\n');
    throw new CardResolutionError(
      `Card "${reference}" exists on ${instances.length} boards — pass ${flag} to say which:\n${listed}`,
      reference,
      instances,
      flag,
    );
  }
}

export default CardReferenceResolver;
