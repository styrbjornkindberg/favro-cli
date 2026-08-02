/**
 * One comparison key for every place a user-typed name meets a name from the
 * wire (#141).
 *
 * THE BUG THIS CLOSES
 * Unicode gives two byte sequences for the same visible string: precomposed
 * cafe-acute (one code point) and decomposed cafe-acute (plain e plus a
 * combining acute). macOS filesystems and input methods often produce the
 * second, most other sources the first. `toLowerCase()` does not reconcile
 * them, so a tag typed on one platform refused against the same tag typed on
 * another — and the refusal listed a candidate that looked identical to what
 * had just been typed, which reads as a haunted CLI rather than a miss.
 *
 * FOR COMPARISON ONLY — NEVER FOR STORAGE OR DISPLAY
 * The canonical spelling belongs to Favro. Nothing here may be written back to
 * the API, put in a card, or printed in place of what the wire returned; a
 * refusal must still list the org's own bytes. This function exists to answer
 * "are these the same name", and that is all it may be used for.
 *
 * ORDER: NORMALISE, TRIM, THEN LOWERCASE
 * Composition is a property of the input, so the bytes are settled before
 * anything else looks at them. The alternative order was measured rather than
 * assumed: over every code point from U+0020 to U+2FFFF, in both NFC and NFD,
 * `x.normalize('NFC').toLowerCase()` and `x.toLowerCase().normalize('NFC')`
 * agree on all of them. The order is therefore free, and it is pinned here so
 * it stops being a coin flip made separately at each call site — which is how
 * these seams came to hold three near-identical private `norm` helpers.
 *
 * NFC, NOT NFKC
 * NFKC additionally folds compatibility characters — the fi ligature to "fi",
 * a circled digit one to "1". That is a much larger claim than "the same name
 * spelled two ways", and it would make distinct tags collide.
 *
 * The trim matches what `column-directory`, `name-resolve`, `tags-api`,
 * `users-api` and `cards-api` each already did on their own.
 */
export const foldName = (value: string | null | undefined): string =>
  (value ?? '').normalize('NFC').trim().toLowerCase();
