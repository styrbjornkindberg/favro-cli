# ADR-0001: Blocking edges are checked per pair, not for transitive cycles

Status: accepted (#53, recorded by #64)

## Context

Favro stores at most **one** dependency edge per card pair — `isBefore`, undirected
identity with directed semantics. `add-blocking-edge` (`src/lib/dispatch.ts`) settles a
pair with one bounded read: `tx.liveEdge(card, blockedBy)` (`src/lib/tx-cards.ts`).

The old guard, `wouldCreateCycle`, walked the graph with BFS before every link. It was an
unbounded derived-N walk, followed `depends-on` links only, and its bare `catch {}` passed
the check silently whenever a read failed. #53 deleted it.

## Decision

Keep the pair check. Do not reinstate transitive cycle detection.

**Caught:** the pair, in both directions, in one call. Exact edge present → `created: false`,
no write. Reverse edge present → `ReverseEdgeError`, a refusal naming the delete-then-add
path. Neither → write. The race window falls through to one re-read gated on the
`conflict` classification; `403 "Dependency already exists"` is **not** treated as success —
it fires for a duplicate, a flipped write and the mirror end alike, so the wire is asked
which it was, and a 403 with no visible edge rethrows rather than inventing an answer.

**Not caught:** any cycle of length >= 3. `A→B→C→A` is refused by nothing. Favro's 403 fires
only on a duplicate *pair* edge, so no layer rejects a transitive cycle.

**What a user sees:** the write succeeds. Nothing warns. `unblocked` (#47) then degrades
sanely rather than lying: every card in the cycle has an unfinished blocker, so all of them
stay out of the frontier permanently and none is ever offered as takeable. Over-blocking, the
one direction #47 is deliberately wrong in. The cycle must be found and broken by hand with
`remove-blocking-edge`.

## Why the loss was accepted

An unbounded walk with a swallowing catch is worse than no check: it reads as a guarantee it
never gave. This is a reliable check of a narrower property replacing an unreliable check of a
broader one — not "no loss". A 3-cycle in a blocking graph is rarer than the false confidence
the BFS sold.

## Revisit when

Real 3-cycles show up. The shape to build is a bounded transitive check with a cap and honest
holes, the way `boundedSweep` reports `unreachable` (`src/lib/read-shape.ts`) — never a silent
pass on a failed read.
