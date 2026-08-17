---
name: favro-cli
description: How to use the favro-cli tool to manage Favro project management boards, cards, collections, members, and more via the command line. Use this skill whenever the user asks about Favro cards, boards, sprints, backlogs, standup views, batch card updates from a CSV, card linking, project planning, or any task involving the Favro workspace. Also use this skill when you need to look up, create, update, move, or query cards on Favro boards — even if the user doesn't explicitly mention "favro" but is clearly talking about their project management workflow. This is the authoritative guide for safe CLI usage with write-safety guardrails.
---

# Favro CLI

**The command surface belongs to `--help`.** It is generated from the code, so it
cannot drift; anything written here instead would be a second copy, and MCP
`favro_help` shells out to `--help` anyway. What is written here is the part
`--help` does not carry: what the things ARE.

Before your first write, run:

```bash
favro help issue-tracker
```

That topic carries the whole contract: the mandatory scope lock, every intent and
its CLI spelling, the two relationships (and the unordered one that does not
exist), the retry contract, and — up front — what a failed multi-step write may
leave behind.

Then: `favro --help`, `favro <command> --help`, `favro skill list`.

---

## The model — read this before the contract makes sense

The contract topic says things like *"delete removes ONE board instance; other
instances of the same `cardCommonId` survive."* That sentence is only safe to act
on if you know what a board instance is.

```
Organization
  └── Collection          what the scope lock locks
       └── Board          Favro's wire calls it a WIDGET
            └── Column    the card's status IS its column
                 └── Card one work item, once per board it sits on
```

**card** — one work item. A card exists **once per board it sits on**, so "the
card" and "this instance of the card" are different things. That is why `delete`
removes one board instance and the others survive, and why a card can be counted
on two boards.

**The three card identifiers.** All three are accepted wherever an argument is
card-shaped, and translated to whichever one the endpoint consumes:

| identifier | what it names | who takes it |
|---|---|---|
| `sequentialId` | the human label, `CLA-1804` | anywhere; a bare `8850` is the same thing |
| `cardId` | ONE board instance | path segments |
| `cardCommonId` | the card across ALL its instances | comments, tasks, tasklists — in a query or body, never a path segment |

The `sequentialId` prefix is derived by Favro from the collection name and is not
an API field. `cardId` and `cardCommonId` **share one syntax** (24-char hex), so
nothing can tell them apart by looking — detection is shape-first and escalates
only on a classified not-found. This is the single most common source of
confusion in this API; if a call returns nothing, suspect you passed the other one.

**board** — where cards live, and the unit the scope lock checks. Favro's wire
calls it a **widget**: the id is `widgetCommonId` and the endpoint is `/widgets/`,
renamed to `boardId` for everything above the API layer. Every board-shaped
argument accepts a **name or an id**. That is not convenience: Favro answers
**200 with an empty page** for a `widgetCommonId` nobody has, so an unsettled name
would be zero rows rather than an error — the name is resolved before it reaches
the wire.

**fork** — a card with no `widgetCommonId`: the boardless, columnless entity Favro
creates **on assignment**. It is unactionable by construction. This is why `claim`
assigns and moves on the tracker-board instance only.

**column-as-status** — a card's status *is* its column. There is no `state` field
on the wire, so the open/closed axis is two `columnId`s and nothing else. Columns
resolve by id or by name, and a name **requires a board**, because a column name is
only unique within one.

**collection** — the container boards belong to, and what the scope lock locks.

**the scope lock is per-SHELL if you want it to be.** `favro scope set <id>` writes
`~/.favro/config.json`, which every shell on the machine shares — so if you are one of
several agents working the same workspace, `scope set` retargets everybody else's next
write, not just yours. Export the variable instead:

```bash
export FAVRO_SCOPE_COLLECTION_ID=<collectionId>
```

It overrides the file for this shell and every child process, needs no write, and dies
with the session. `favro scope show` reports the effective lock **and its source**, so
check that rather than assuming. Four things worth knowing before you rely on it:

- Setting it to an EMPTY or whitespace-only value is an **error**, not "no lock" — a typo
  cannot silently unlock every board.
- `scope set` and `scope clear` **refuse** while it is set, because they write a file lock
  nothing in that shell will read. Change the export instead.
- The id is not verified against the wire (`scope set` verifies; this does not). A wrong
  id fails closed: every board mismatches and every write refuses.
- It retargets READS too, not just the write guard: `health`, `next`, `my-cards`,
  `my-standup`, `overview`, `team`, `stale`, `workload` and `init` all default to the
  effective lock when given no `--collection`.

**tag** — an org-wide label, written **by name**. Names are the vocabulary: an
unknown name is refused client-side, because on a tag write Favro reads an unknown
name as a tag *creation*. The triage vocabulary rides tags because the column
already carries open/closed and cannot carry both.

**blocking edge** — the only ordering relationship Favro can store. **One edge per
card pair**, carrying a single flag describing the linked card relative to the one
you queried; reading from the far end returns the same edge inverted. Undirected
identity, directed semantics — so a pair holding the reverse edge can never take
the forward one, and reversing is delete-then-add. Favro says before/after where
this CLI says blocks/blocked-by: one edge, two vocabularies. **There is no
unordered "related to"** — Favro cannot store one, so do not model it with a
blocking edge or a parent; both mean something else and read back as what they mean.

**hierarchy** — `--parent` on create. Same board only, 1:N.
