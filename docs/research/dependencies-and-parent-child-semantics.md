# Favro dependencies and parent/child: identifiers and semantics

Research for [#4](https://github.com/styrbjornkindberg/favro-cli/issues/4) (part of #1).
Date: 2026-07-31. Sources: <https://favro.com/developer/> (single-page API reference, fetched
2026-07-31) and this repo.

Every claim below is cited to that doc page or to a `file:line`. Where the docs say nothing, the
section says so explicitly instead of guessing.

---

## Headline

**Favro has no `depends-on` / `blocks` / `related` / `duplicates` link types.** The word "blocks"
does not appear in the dependency section of the API reference at all. Favro's dependency model is
a single directional edge with one boolean, `isBefore`. The four link types are an invention of
this CLI (`src/commands/cards-link.ts:10`), and the request body the CLI sends does not match the
documented schema.

Consequence: `favro dependencies add`, `favro cards link`, `favro cards dependencies`,
`favro cards blocking`, and `favro cards blocked-by` cannot be working against the live API today.
Details in [CLI mismatch](#cli-mismatch-what-is-actually-broken).

---

## 1. Dependencies

### 1.1 Endpoints (all documented under "Dependencies", <https://favro.com/developer/#dependencies>)

| Method | Path | Doc text |
|---|---|---|
| GET | `/cards/:cardId/dependencies` | "This endpoint retrieves all the dependencies of a card." (<https://favro.com/developer/#get-all-dependencies>) |
| POST | `/cards/:cardId/dependencies` | "This endpoint adds new dependencies to a card." (<https://favro.com/developer/#create-dependencies>) |
| PUT | `/cards/:cardId/dependencies` | "This endpoint removes all previous dependencies and sets the new dependencies to a card." (<https://favro.com/developer/#update-dependencies>) |
| PATCH | `/cards/:cardId/dependencies/:dependencyCardId` | "This endpoint updates a specific dependency of a card" (<https://favro.com/developer/#update-a-card-dependency>) |
| DELETE | `/cards/:cardId/dependencies/:dependencyCardId` | "This endpoint deletes a concrete card dependency." (<https://favro.com/developer/#delete-a-card-dependency>) |
| DELETE | `/cards/:cardId/dependencies` | "This endpoint deletes all the dependencies of a card." (<https://favro.com/developer/#delete-all-dependencies>) |

All six require the `organizationId` header ("For this endpoint it is required to send in the
organizationId of the organization that this call is being made against.").

Dependencies can also be set on the card itself, not only via these endpoints:

- Create a card accepts `dependencies` — "The list of the card dependency options for a card."
  (<https://favro.com/developer/#create-a-card>)
- Update a card accepts `addDependencies` — "The list of card dependency options that will be added
  to the card. Optional." — and `removeDependencies` — "The list of dependency card ids that will be
  removed from the card. Optional." (<https://favro.com/developer/#update-a-card>)

### 1.2 Which identifier — `cardId`, always

The "Card dependency options" table (the write shape) has exactly two fields
(<https://favro.com/developer/#card-dependency-options>):

| Field | Type | Description (verbatim) |
|---|---|---|
| `cardId` | string | "The cardId of the dependency card." |
| `isBefore` | boolean | "Indicates if the dependency is before this card." |

Path parameters are `cardId` too: "The id of the card whose dependencies are to be retrieved." and,
for `:dependencyCardId`, "The cardId of the dependency to be deleted."
(<https://favro.com/developer/#delete-a-card-dependency>).

So: **`cardId` (the per-widget instance id) on both ends, in the path and in the body. Never
`cardCommonId`, never `sequentialId`.** `cardCommonId` appears in dependency *responses* as an extra
descriptor, and `sequentialId` appears nowhere in the dependency section. The only place the API
accepts `cardSequentialId` at all is the `GET /cards` list filter
(<https://favro.com/developer/#get-all-cards>) — which is how the CLI's
`findCardBySequentialId` (`src/lib/cards-api.ts:526`) has to translate `CLA-1804` into a `cardId`
before any dependency call.

### 1.3 The read shape — "Card dependency"

<https://favro.com/developer/#card-dependency>:

| Field | Type | Description (verbatim) |
|---|---|---|
| `cardId` | string | "The cardId of card that is a dependency." |
| `cardCommonId` | string | "The cardCommonId of card that is a dependency." |
| `isBefore` | boolean | "Indicates if the dependency is before this card." |
| `reverseCardId` | string | "The cardId of this instance." |

GET response envelope (verbatim example from <https://favro.com/developer/#get-all-dependencies>):

```json
{
  "cardId": "67973f72db34592d8fc96c48",
  "cardCommonId": "ff440e8f358c08513a86c8d6",
  "organizationId": "zk4CJpg5uozhL4R2W",
  "dependencies": [
    {
      "cardId": "eRryDkeAwojKHXBML",
      "cardCommonKey": "ff440e8f358c08513a86c8d6",
      "isBefore": true,
      "reverseCardId": "67973f72db34592d8fc96c48"
    }
  ]
}
```

Two things to note. The envelope key is `dependencies`, **not** `entities` — this is not the
paginated-collection shape used elsewhere in the API. And the example emits `cardCommonKey` where
the field table says `cardCommonId`; one of the two is a doc bug. Treat both keys as possible in
responses.

The card object itself also carries `dependencies` — "The list of card dependencies of the card."
(<https://favro.com/developer/#card>) — so a plain `GET /cards/:cardId` may already answer the
question without a second call. **Docs do not say whether `dependencies` is returned unconditionally
or requires a flag.** Unverified; worth an empirical check.

### 1.4 Symmetry — partially answered, partially undocumented

There is no `type` on an edge, so the four-way symmetry question in #4 does not apply as posed.
What exists is direction, carried by `isBefore`. The documented facts:

- `isBefore` on a dependency of card X means "Indicates if the dependency is before this card" —
  i.e. direction is expressed *relative to the card you queried*, not as an intrinsic property of
  the pair.
- `reverseCardId` is "The cardId of this instance" — every dependency record fetched for card X
  carries X's own id back. That naming ("reverse") plus the relative reading of `isBefore` strongly
  suggests one stored edge rendered from either end, rather than two independent records.
- The doc's own POST example sends `"isBefore": false` and shows a response containing
  `"isBefore": true` for that same pair (<https://favro.com/developer/#create-dependencies>).
  That is either a copy-paste artefact in the example or evidence that the server normalizes /
  reverses direction on write.

**The docs never state whether `GET /cards/:targetId/dependencies` returns the mirror edge, nor
what `DELETE` from the far end does.** Do not assume. This is the single highest-value empirical
test to run against a live org before building wayfinder's blocked-by edge on it:

1. `POST /cards/A/dependencies` with `{"dependencies":[{"cardId":"B","isBefore":false}]}`
2. `GET /cards/B/dependencies` — does A appear, and with which `isBefore`?
3. `DELETE /cards/B/dependencies/A` — does the edge on A disappear?

### 1.5 Removal

Two documented paths, both keyed by `cardId`: `DELETE /cards/:cardId/dependencies/:dependencyCardId`
for one edge, `DELETE /cards/:cardId/dependencies` for all. Plus `removeDependencies` on card update
("The list of dependency card ids that will be removed from the card"). `PUT` is destructive —
"removes all previous dependencies and sets the new dependencies".

---

## 2. Parent / child

### 2.1 Identifier

`parentCardId`, a **`cardId`** — the per-widget instance id, same as everywhere else.

Card object (<https://favro.com/developer/#card>), verbatim:

> `parentCardId` — string — "The id of the parent card in the card hierarchy (sheet or card list).
> Only returned if the card exists in a widget and is the child of another card."

Create a card (<https://favro.com/developer/#create-a-card>), verbatim:

> `parentCardId` — string — body — "The id of the parent card in the card hierarchy (sheet or card
> list). It must belong to the widget specified in the widgetCommonId parameter."

Update a card (<https://favro.com/developer/#update-a-card>), verbatim:

> `parentCardId` — string — body — "The id of the parent card in the card hierarchy (sheet or card
> list), where the card will be commited. It must belong to the widget specified in the
> widgetCommonId parameter. Optional."

### 2.2 Cross-board — no

"It must belong to the widget specified in the widgetCommonId parameter" appears in both the create
and the update description. Parent and child live on the same widget (board). There is no documented
way to parent a card to a card on another board.

Corollary for update: `parentCardId` is described relative to `widgetCommonId`, so a `PUT /cards/:id`
that sets `parentCardId` without also sending `widgetCommonId` is under-specified by the docs.
**The docs do not say what the server does in that case** — whether it defaults to the card's current
widget or errors. Unverified. This matters because `favro cards update --parent` sends exactly that
payload unless `--column` was also passed (`src/commands/cards-update.ts:87`,
`src/lib/cards-api.ts:496-514`).

### 2.3 Depth limit

**The docs state no depth limit.** No sentence in the reference bounds hierarchy depth, and there is
no `depth`/`level` field on the card object. Absence of a documented limit is not proof there is
none — the Favro UI's sheet view is the real constraint and it is not described here. Unverified.

### 2.4 Related fields

Hierarchy position is `sheetPosition` — "Position of the card in a hierarchical view (sheet or card
list)." (<https://favro.com/developer/#card>). The deprecated `position` field maps to
`sheetPosition` for left-pane widgets and `listPosition` for right-pane ones. The CLI touches
neither.

---

## 3. The cardCommonId question — does either relationship survive multi-board cards?

Framing, verbatim from <https://favro.com/developer/#cards>:

> "In Favro, a card can exist on multiple widgets. As a result of this, a card contains a
> cardCommonId that is the shared id for all instances of this card."

**Parent/child: instance-scoped, definitively.** `parentCardId` is "Only returned if the card exists
in a widget and is the child of another card", and the parent "must belong to the widget specified
in the widgetCommonId parameter". Parenting is a property of one instance on one widget. The same
logical card on a second board is a different `cardId` and carries its own (probably absent)
`parentCardId`. It does not follow the card.

**Dependencies: instance-keyed writes, but the read exposes `cardCommonId`.** Both ends are written
by `cardId` (§1.2), so the edge is created between two instances. But the read shape includes
`cardCommonId` per dependency, and the GET envelope reports the queried card's own `cardCommonId`
— suggesting Favro tracks the common identity alongside the edge. **The docs do not say whether a
dependency created against instance A-on-board-1 is visible when you GET A-on-board-2's
dependencies.** Unverified, and it is the second empirical test worth running: add a card to a
second board, then GET dependencies on the new instance's `cardId`.

Practical rule for the CLI either way: **resolve to a `cardId` for a specific board before making
any dependency or parent call.** If a `sequentialId` or `cardCommonId` resolves to multiple
instances, the resolver has to pick one, and which one it picks is semantically load-bearing for
both relationships. That is a direct input to #6.

---

## CLI mismatch: what is actually broken

Comparing the above to the code. These are findings, not fixes.

### 4.1 `linkCard` sends a body Favro does not define

```ts
// src/lib/cards-api.ts:443-450
async linkCard(cardId: string, req: LinkCardRequest): Promise<CardLink> {
  return this.client.post<CardLink>(`/cards/${cardId}/dependencies`, {
    toCardId: req.toCardId,
    type: req.type,
  });
}
```

Favro expects `{"dependencies": [{"cardId": "...", "isBefore": bool}]}`
(<https://favro.com/developer/#create-dependencies>). Neither `toCardId` nor `type` is a documented
field anywhere in the API reference. Every caller is affected: `favro dependencies add`
(`src/commands/dependencies.ts:76`) and `favro cards link` (`src/commands/cards-link.ts:102`).

### 4.2 `getCardLinks` reads the wrong envelope key

```ts
// src/lib/cards-api.ts:434-438
const res = await this.client.get<{ entities: CardLink[] }>(`/cards/${cardId}/dependencies`);
return res.entities ?? [];
```

The documented response has no `entities` — it has `dependencies`. So `getCardLinks` returns `[]`
for every card that has dependencies. Same bug at `src/lib/cards-api.ts:415` in the
`--include links` path.

### 4.3 Everything downstream of `link.type` is dead code

`CardLink` (`src/lib/cards-api.ts:64-69`) declares `linkId`, `type`, `cardId`, `cardName`. Of these,
only `cardId` exists in Favro's dependency object; `linkId`, `type` and `cardName` are invented.
Filtering on `.type` therefore never matches, even if 4.2 were fixed:

- `favro cards dependencies` filters `l.type === 'depends-on'` (`src/commands/cards-link.ts:287`)
- `favro cards blocking` filters `l.type === 'blocks'` (`src/commands/cards-link.ts:329`)
- `favro cards blocked-by` filters `l.type === 'depends-on'` (`src/commands/cards-link.ts:376`)
- `wouldCreateCycle` walks `depends-on` edges (`src/commands/cards-link.ts:31`) — always reports
  no cycle
- `favro dependencies list` prints `lnk.type` as a column (`src/commands/dependencies.ts:34`)

The `blocked-by` implementation already carries a comment conceding the model is guesswork
(`src/commands/cards-link.ts:370-375`). The real mapping is one boolean: `isBefore`.

### 4.4 What is correct

`unlinkCard` → `DELETE /cards/:cardId/dependencies/:fromCardId` (`src/lib/cards-api.ts:454`) and
`deleteAllDependencies` → `DELETE /cards/:cardId/dependencies` (`src/lib/cards-api.ts:461`) both
match the documented endpoints exactly. The delete paths are the only part of the dependency surface
that lines up.

### 4.5 Why CI never caught it

The only tests touching this are integration tests that early-return without credentials:

```ts
// tests/integration/spec-002-complete.test.ts:1398
it('linkCard creates a link between cards', async () => {
  if (!cardA || !cardB) return;
  ...
```

No unit test asserts the request body or response parsing, so the shape mismatch is invisible to the
suite.

### 4.6 Parent/child code

`favro cards create --parent` passes `parentCardId` straight through
(`src/commands/cards-create.ts:67`), and `createCard` maps `boardId → widgetCommonId`
(`src/lib/cards-api.ts:479-482`), so the documented "must belong to the widget specified in the
widgetCommonId parameter" constraint is at least expressible — but nothing validates it, so a
mismatched pair fails server-side with whatever Favro returns. `favro cards update --parent`
(`src/commands/cards-update.ts:87`) omits `widgetCommonId` entirely unless `--column` was passed;
see §2.2 for why that is undocumented territory.

---

## Answers to #4, condensed

| Question | Answer |
|---|---|
| Dependency source/target identifier | `cardId` on both ends, path and body. Not `cardCommonId`, not `sequentialId`. |
| Are the four link types symmetric? | The four types do not exist in the Favro API. One directional edge with `isBefore`. |
| Does the inverse edge materialize on the target? | **Docs silent.** `reverseCardId` hints at one shared edge; must be tested empirically. |
| How are edges listed? | `GET /cards/:cardId/dependencies` → `{cardId, cardCommonId, organizationId, dependencies: [...]}`. |
| How are edges removed? | `DELETE .../dependencies/:dependencyCardId`, or `DELETE .../dependencies` for all, or `removeDependencies` on card update. |
| `parentCardId` identifier | `cardId` of the parent instance. |
| Cross-board parenting? | No — parent "must belong to the widget specified in the widgetCommonId parameter". |
| Depth limit? | **Docs silent.** No documented limit, no depth field. |
| Survives multi-board cards? | Parent/child: no, instance-scoped. Dependencies: written per-instance; whether reads follow `cardCommonId` is **undocumented**. |

## Open items for a live-org probe

1. Create A→B, then GET B's dependencies. Mirror edge? Which `isBefore`?
2. Delete the edge from B's side. Does A's copy go?
3. POST `isBefore: false`, GET back — does the server flip it, or is the doc example wrong?
4. Add a card to a second board; GET dependencies on the new instance's `cardId`. Do edges follow?
5. `PUT /cards/:id` with `parentCardId` and no `widgetCommonId` — accepted or rejected?
6. Nest three levels deep on a sheet. Any error?
