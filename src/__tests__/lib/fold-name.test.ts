/**
 * `foldName` — the one comparison key for a user-typed name against a name from
 * the wire (#141).
 *
 * NOT ONE ACCENTED CHARACTER APPEARS IN THIS FILE, ON PURPOSE.
 * Written out as characters, each literal would be whatever normalisation form
 * the editor that last saved this file happened to emit, and a normalising
 * editor can silently rewrite one side of an assertion into the other — at
 * which point the test passes because both sides became identical, not because
 * the fold works. Even a backslash-u escape is only as safe as the tooling that
 * round-trips it. Every non-ASCII character here is therefore BUILT from its
 * code point at runtime, which nothing in an editor or a formatter can touch.
 */
import { foldName } from '../../lib/fold-name';

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

const E_ACUTE = cp(0x00e9); // LATIN SMALL LETTER E WITH ACUTE
const COMBINING_ACUTE = cp(0x0301); // COMBINING ACUTE ACCENT
const E_ACUTE_UPPER = cp(0x00c9); // LATIN CAPITAL LETTER E WITH ACUTE

/** cafe-acute, precomposed: the accented e is one code point. */
const NFC_CAFE = `caf${E_ACUTE}`;
/** cafe-acute, decomposed: plain e plus a combining acute. */
const NFD_CAFE = `cafe${COMBINING_ACUTE}`;

test('the two spellings of cafe-acute really are byte-different to start with', () => {
  // The premise. Without this the rest of the file could be asserting nothing.
  expect(NFC_CAFE).not.toBe(NFD_CAFE);
  expect(NFC_CAFE.length).toBe(4);
  expect(NFD_CAFE.length).toBe(5);
});

test('folds a decomposed name onto its precomposed twin', () => {
  expect(foldName(NFD_CAFE)).toBe(foldName(NFC_CAFE));
});

test('folds case as well, in both directions across the two forms', () => {
  expect(foldName(`CAF${E_ACUTE_UPPER}`)).toBe(foldName(NFD_CAFE));
  expect(foldName(`CAFE${COMBINING_ACUTE}`)).toBe(foldName(NFC_CAFE));
});

test('normalises to NFC, not NFD — the composed form is the key', () => {
  expect(foldName(NFD_CAFE)).toBe(NFC_CAFE);
});

test('is not NFKC — a compatibility character is a different name, not a variant', () => {
  // NFKC would fold the fi ligature (U+FB01) to "fi" and circled digit one
  // (U+2460) to "1". That is a far larger claim than "the same name spelled two
  // ways", and it would make a tag named with the circled digit match one
  // named "1".
  expect(foldName(`${cp(0xfb01)}le`)).not.toBe('file');
  expect(foldName(cp(0x2460))).not.toBe('1');
});

test('trims, the way every name seam that already had its own `norm` did', () => {
  expect(foldName('  Bug \n')).toBe('bug');
});

test('treats null and undefined as the empty key rather than throwing', () => {
  expect(foldName(undefined)).toBe('');
  expect(foldName(null)).toBe('');
});

test('leaves a name that is already a folded ASCII key alone', () => {
  expect(foldName('backend')).toBe('backend');
});

test('the fold is idempotent — a key folded again is the same key', () => {
  const once = foldName(`  ${NFD_CAFE.toUpperCase()}  `);
  expect(foldName(once)).toBe(once);
});
