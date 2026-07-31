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

/**
 * Translate a CLI link-type label to Favro's direction flag.
 * `related` and `duplicates` have no API representation — Favro rejects them —
 * so they raise instead of being silently discarded.
 */
export function linkTypeToIsBefore(type: string): boolean {
  if (type === 'depends-on' || type === 'blocked-by') return true;
  if (type === 'blocks') return false;
  throw new Error(
    `Link type "${type}" cannot be stored in Favro. Favro dependencies have one direction only — use "depends-on" or "blocks".`,
  );
}
