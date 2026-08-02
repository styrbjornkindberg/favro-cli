# ADR-0003: One free-function resolver, and a declared shape table

Status: accepted (#94, grilled 2026-08-01)

## Context

Spec #36 put identifier resolution "inside the API classes, not a CLI shim — so the MCP
passthrough and the skill engine inherit it." It is inside six of them, plus four
re-implementations, plus three fuzzy matchers that do what `name-resolve.ts` forbids in its
own header.

The repetition is the cheapest of its costs.

- **The leaf cache imports its consumers.** `name-cache.ts` imports `TagsAPI` and `UsersAPI`
  so that `cachedTags`/`cachedUsers` can fetch; both classes import `name-cache` back.
  `madge --circular` confirms two cycles. The fix already exists twelve lines away:
  `name-resolve.ts` takes `fetch: () => Promise<NamedRef[]>` as an option and imports no API
  class at all.
- **Two philosophies of shape-sniffing coexist, and neither is written down as a rule.**
  `users-api.ts:23` decides on shape with no escalation, and earns it — *"`userId` is NEVER
  hex-24 — 135/135 measured are base62-17"*, plus *"every one of 135 measured user names
  contains a space"*. `tags-api.ts:19` likewise — *"`tagId` has TWO measured shapes inside one
  organization — 27 hex-24 and 222 base62-17. A hex-24-only classifier misses 11%"*. Against
  that, `name-resolve.ts:41` is *"deliberately weak … shape alone never decides"*, and
  `card-reference.ts:11` assumes hex and escalates only on a classified not-found. Which
  regime applies to which resource is inferable only by reading four files' prose.
- **The measurements are comments.** `135/135`, `27 + 222`, `11%` — the most valuable facts in
  the resolution path, and none of them is executable. `BASE62_17` is declared byte-identically
  twice (`users-api.ts:25`, `tags-api.ts:23`); `HEX_24` exists once (`tags-api.ts:22`) and is
  relied on implicitly by the card resolver without ever being written down.
- **Two live fuzzy matchers silently answer about the wrong resource.** `api/context.ts:198`
  falls back to `boards.find(b => b.name.toLowerCase().includes(lower))` — first match wins, no
  ambiguity refusal — and is imported by 8 command modules. `api/aggregate.ts:305` does the same
  for collections across 9. `context.ts:190` also caps at `listBoards(100)` against an org
  measured at 322 boards, so it misses two-thirds of them before fuzziness enters.
- **`readFile()` is unmemoized.** Every `readCache`, `readCacheRecord`, `writeCache` and
  `invalidateCache` re-reads and re-parses the whole cache file. Resolving N columns in a sweep
  costs N full parses.

## Decision

One free-function resolver module, a declared shape table, no fuzzy fallbacks, and a memoized
cache file. Object lifetime is left exactly as it is.

### The resolver is free functions in `name-resolve.ts`, not an injected layer

`name-resolve.ts` grows into the resolver; the `*-api` classes call it and pass their own
`fetch`. No new module, no constructor injection.

An injected resolution layer was rejected on two counts. It adds a constructor argument to
every `*-api` class, which the runner from ADR-0002 would then have to build and thread — and
ADR-0002's own revisit clause says widening `Ctx` is how a seam becomes a god object. Scope was
deliberately kept off `ctx` for that reason; resolution would be the second thing arguing its
way on. And it is not needed for the stated benefit: the import cycle is not a DI problem.
`name-cache` takes a `fetch` callback exactly as `name-resolve` already does, drops its two
class imports, and the cycle dies. `cachedTags`/`cachedUsers` move out to their callers.

### The shape table is data, with a decides/hints column

A plain `const` map, one row per resource: the shapes its ids take, whether shape **decides**
or only **hints**, and the measurement that earned the row. Predicates derive from the table.
One table-driven test asserts every declared shape against the measured sample ids, so a third
`tagId` shape in some future org fails loudly instead of silently misclassifying 11% again.

The decides/hints column is the point. It is the fact most likely to be got wrong next, and in
a table a reviewer sees `boardId: hints` beside `userId: decides` and cannot mis-copy one for
the other.

Scope limits, held deliberately: a `const` object and derived predicates — no runtime registry,
no per-resource classes, no plugin shape. The table declares **which shapes a resource's ids
take**. It never declares **which resource an unknown id belongs to** — that question has no
measurement behind it and gets no home here.

### Fuzzy matching is deleted, not flagged

`api/context.ts:198` and `api/aggregate.ts:305` are deleted and routed through `resolveBoardId`
/ `resolveCollectionId`. There is no `--fuzzy` opt-in.

A partial board-name hit returns the wrong board's cards with no signal — the same failure mode
as #82, which is already filed as land-now. A flagged version keeps the bug and adds a way to
ask for it. `name-resolve` already holds the correct behaviour: exact, trimmed,
case-insensitive, refusing ambiguity with every colliding id and the flag that settles it.
A flag would also be a second grammar, which #95 exists to delete one ticket over; and
ADR-0002 made JSON the default in 3.0.0, so "keep it for interactive commands where a human
reads the result" assumes the reading that is no longer the default.

The cost, named: `favro standup --board "Dev"` stops guessing and starts refusing with a candidate
list. Routing through the resolver also fixes the 100-board cap for free, because the resolver
paginates to completion.

Both hand-rolled Levenshtein implementations (`action-parser.ts:621`, `api/propose.ts:109`) are
out of scope here — they are reachable only through `propose`, and die with #96.
`query-values.ts:77` is **not** a fuzzy matcher and stays: it is the declared `~` operator, and
already documented closed — *"a substring matching no tag can only ever return nothing."*

### Lifetime is unchanged; the cache file is memoized

`ColumnDirectory` and `CardReferenceResolver` stay per-call. The premise that they re-read the
cache on construction is false: `CardReferenceResolver` holds only `client`, and
`ColumnDirectory`'s constructor builds two API objects and nothing else. Construction is free.

Making them process-scoped singletons would buy nothing measurable and cost an ownership
question — who resets them between tests, with #97 already open on the test-seam mess.

The measurable win is in `name-cache`: memoize the parsed file, **keyed by `cacheFilePath()`**,
cleared on write. That fixes the N-parses problem for every caller at once, including those that
never touch a resolver object (`query-values`, `tags.ts`, `tracker-init`). Keying by resolved
path is load-bearing, not decoration: `name-cache.ts:4` records that `favro-mcp-http` gives each
tenant its own cache file via `FAVRO_CONFIG_DIR`, and `cacheFilePath()` re-reads the env per call
precisely to honour that. A bare module global would serve one tenant's cache to another.

Accepted risk, unchanged from today: a second CLI process writing the cache mid-command is not
seen. That is already the posture — last-writer-wins whole-file rewrite plus a 15-minute TTL.

## Consequences

- **The work splits in two, and Part A collides with nothing.** Part A is the shape table, the
  `fetch` callback, the memo and the two fuzzy deletions — `src/lib/*` plus two `src/api/*`
  files, and **nothing in `src/commands/`**, which is where ADR-0002's chain lives almost
  entirely. `tags-api` and `users-api` re-export `isTagId`/`isUserId` from the table, so all
  four `isUserId` call sites keep compiling untouched and #92's chain never sees the change.
- **Part B is blocked by #110.** Collapsing the four re-implementations
  (`CardsAPI.findCardBySequentialId`, `blocking.ts`, `commands/tracker-init.ts`,
  `lib/tracker-config.ts`), retiring the duplicate `resolveCollectionId` and the second
  `Collection` interface, and dropping the re-exports all touch files that #92 and #93 are
  actively rewriting. Two of the four `isUserId` sites are in `bulk.ts`, which #110 deletes —
  waiting means migrating them never happens at all.
- **#82 is unaffected and still lands now.** `--board <name>` answering zero rows is a missing
  call to `resolveBoardId` on the card path, not a consequence of this consolidation.
- The import cycle disappears from `madge --circular`, which makes a cycle check meaningful as a
  CI gate for the first time.

## Revisit when

A resource needs shape-sniffing that no measurement supports. The table has room for the row;
what it must not grow is a `maybe` between `decides` and `hints`. An unmeasured shape is a hint,
and a hint that cannot be escalated on a classified not-found is not a resolution strategy.
