# ADR-0004: Delete `propose` / `execute` — the frozen plan has no consumer

Status: accepted (#96, grilled 2026-08-01)

## Context

`favro propose <board> '<natural language>'` parses an English instruction into a plan, stores
it under a change id, and prints the id. `favro execute <change-id>` was to apply it. The pair
was SPEC-003's headline feature: "Enable AI to understand board state, propose changes, and
execute updates with minimal ambiguity."

**The handshake has never completed.** `propose` writes the plan to an in-memory `Map` with a
10-minute TTL (`change-store.ts`), then the process exits and the `Map` dies with it. `execute`
runs in a **new process**, reads `null`, and prints *"Change ID … not found or has expired"*.
The 536-line `api/propose.test.ts` passes because it drives both halves inside one Jest
process. MCP `favro_run` shells the CLI once per call, so it inherits the same break.

So the shipped feature is a `propose` that answers, and an `execute` that cannot ever succeed.

Fixing the handshake is not the whole bill. The plan `propose` emits is wrong on the wire in
four independent ways:

- `api/propose.ts` reaches **through** the typed client to its private axios instance and fires
  the calls **in parallel with no rollback**, while its own docstring claims they apply
  atomically. If that private field is ever absent it silently no-ops and still reports
  `result: 'success'`.
- Paths carry a doubled `/api` against a `baseURL` that already ends `/api/v1`.
- The bodies are whole-array `status` / `assignees` writes, which `cards-api.ts` documents as
  **silent no-ops** — Favro answers 200 and performs nothing.
- Links are emitted as `{type:'relates'}`, which `favro help issue-tracker` states Favro cannot
  store.

Behind the two commands sit `action-parser.ts` (775 lines, with a dead `resolveCard` that
`api/propose.ts` re-implements alongside its own second hand-rolled Levenshtein),
`action-parser-api.ts` and `types/actions.ts` (reachable only from their own test), and
`change-store.ts`. Roughly 1 700 lines, plus three test files.

## Decision

**Delete the whole island.** No cross-process persistence, no wire-shape correction, no routing
through the dispatch table.

### Why not persist the plan to disk

Writing the plan under `~/.favro/` would make the handshake work, and it would buy one property
`--dry-run` genuinely lacks: a **frozen plan**. `--dry-run` previews and exits; a later real
invocation re-resolves, so the board can move underneath between preview and apply. `execute
<id>` would replay exactly what was shown.

That property was the only reason to keep the shape, and **it has no consumer**. It pays off
only where a preview is approved out-of-band — a human reading the plan in Slack or a PR
comment, minutes later, with the apply required to be byte-identical. Every real use resolves
inside one agent turn, where `--dry-run` followed by a real invocation is sufficient.

Keeping it would also have meant designing a TTL policy, a cleanup story, and a per-user
isolation story matching what `favro-mcp-http` does with `FAVRO_CONFIG_DIR` — on top of the
four wire fixes and a rewrite onto the dispatch table (#92). All of it to serve nobody.

`--dry-run` on the dispatch table (`dispatch.ts:278`) already returns the whole chain the
invocation would run, from inside the closed write seam. Plan-then-apply is served.

### Why no refusal stub

[#110](https://github.com/styrbjornkindberg/favro-cli/issues/110) established that a removed
command stays registered, exits 1, and names its replacement — *"an agent that hits 'unknown
command' has nothing to recover with; one that hits a stub gets a next move."*

That precedent does **not** extend here, on one fact: `batch` worked. Agents hold working
`batch` habits, so a stub redirects a live workflow. `propose`/`execute` has never completed,
so there is no habit to redirect and nothing regresses. `propose` and `execute` become plain
unknown commands, and the docs that taught them are removed in the same change — the reason an
agent types `favro propose` today is `EXAMPLES.md`, not experience.

A stub would also have had no honest one-line target. `propose` took **natural language**, and
NL action parsing dies with `action-parser.ts`; the replacement is two steps and a different
mental model (`cards list --filter …`, then `cards update --from-csv … --dry-run`). A stub
pointing at that is a tutorial, not a redirect.

### Natural-language action parsing goes with it

`action-parser.ts` exists only to feed `propose`. Nothing else consumes NL action parsing, and
the closed query vocabulary (`query-parser.ts`, `query-values.ts`) is the project's answer for
turning agent intent into a query — it refuses an unknown token by name instead of guessing.
Reintroducing a guessing parser beside it would re-open exactly the fail-open hole #95 closes.

Both hand-rolled Levenshtein implementations die here, as ADR-0003 anticipated
(`action-parser.ts:621`, `api/propose.ts:109`). `query-values.ts:77` survives — it is the
declared `~` operator.

### SPEC-003 is deleted, not annotated

`specs/SPEC-003-llm-optimized-commands.md` and `specs/SPEC-003-tasks.md` specify the deleted
feature. A spec kept "as historical record" describing commands the CLI does not have is a
document an agent can read and act on. It goes. `specs/SPEC-002-tasks.md:277` mentions SPEC-003
as then-future work and stays — that is a genuine historical note, not an instruction.

## Consequences

- ≈1 700 lines and 3 test files removed. `src/api/` loses its largest module; `src/lib/` loses
  its largest.
- **`favro execute` stops being the eighth unrouted write path.** #92's write seam no longer
  has to absorb a raw-axios parallel replay, so
  [#112](https://github.com/styrbjornkindberg/favro-cli/issues/112) closes without work.
- Docs shrink: `EXAMPLES.md` loses its `Parsing & Action Errors` section and the `propose` step
  from three of the four `AI-Powered Workflows`; `API-REFERENCE.md` loses `Parsing & Natural
  Language` and `Dry-Run Mismatch`.
- **No supported way to say "do this" in English.** That is the intended outcome: the closed
  vocabulary refuses precisely, and a parser that guesses answers a plausible wrong thing —
  the failure mode `query-parser.ts:387` records killing.
- If the frozen-plan guarantee ever acquires a consumer, it returns as a **new** design inside
  the dispatch table — a stored chain of intent invocations over one compensation log — not as
  a revival of this code.
