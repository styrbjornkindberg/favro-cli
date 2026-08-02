/**
 * Favro dependency direction.
 *
 * Favro has no link "types". A dependency is one edge carrying a single flag,
 * `isBefore`, describing the linked card relative to the card you queried —
 * verified live against the API (issue #12). Reading the edge from the far end
 * returns it with `isBefore` inverted, so both directions are the same edge.
 *
 * Lives in its own module rather than in `cards-api` because command modules
 * import it while jest-automocking `cards-api`.
 */

/** The only two link labels Favro can actually store. */
export const LINK_TYPES = ['depends-on', 'blocks'] as const;

export type LinkType = (typeof LINK_TYPES)[number];

/**
 * The direction each published label means. **One row per member of
 * `LINK_TYPES`, enforced by the compiler** — the `Record` key type is derived
 * from the tuple, so adding a label without deciding its direction is a
 * `tsc` error (TS2741), not a silent default.
 *
 * That exhaustiveness is the whole point of the table (#120 item 3). The first
 * attempt at this fix derived only the GUARD from `LINK_TYPES` and left the
 * direction as `return type === 'depends-on'` — which trades a fail-open guard
 * for a fail-open ANSWER: a third label would have passed the guard and been
 * written backwards, silently, with nothing but a hand-maintained test array
 * to catch it. A wrong edge is worse than a refused one.
 */
const IS_BEFORE: Record<LinkType, boolean> = {
  'depends-on': true,
  blocks: false,
};

/**
 * Translate a CLI link-type label to Favro's direction flag.
 * `related` and `duplicates` have no API representation — Favro rejects them —
 * so they raise instead of being silently discarded.
 *
 * The guard reads `LINK_TYPES` rather than repeating its members. It used to
 * accept a third label, `blocked-by`, that `LINK_TYPES` never published. The
 * direction it chose was right, so no write ever landed the wrong way round —
 * but `cards link` validates against `LINK_TYPES` and refused that label while
 * `dependencies add` handed it straight here and took it. One `--type` flag,
 * two accepted sets, and the wider one was undocumented. A closed vocabulary
 * that accepts a token it does not publish is a vocabulary in name only, so the
 * declaration is now the only list there is.
 *
 * `blocked-by` survives everywhere it was actually declared — the `cards
 * blocked-by` subcommand, the `blocked-by:` query predicate and `cards create
 * --blocked-by` are all separate surfaces that never routed through here.
 */
export function linkTypeToIsBefore(type: string): boolean {
  if (!isLinkType(type)) {
    throw new Error(
      `Link type "${type}" cannot be stored in Favro. Favro dependencies have one direction only — use ${LINK_TYPES.map((t) => `"${t}"`).join(' or ')}.`,
    );
  }
  return IS_BEFORE[type];
}

/** Narrows an arbitrary string to a published link label. */
export function isLinkType(type: string): type is LinkType {
  return LINK_TYPES.some((known) => known === type);
}
