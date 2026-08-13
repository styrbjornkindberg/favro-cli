# What `PUT /cards/{cardId}` does to `name`, `description`, `dueDate` and `customFields`

Research for GitHub issue #106 (part of #80, step 1 of the sequence in #92). Probed live on
2026-08-13 against the scratch board provisioned by #105 — organization
`b0b311ac98a0250191573541`, collection `2a589d523d54aa9487cf408a`, board
`5dd75f0d5116020817ebe70a` (`Kanban`), column `Todo` `b2cddf969e31126a57d1568e`.

Three throwaway cards were created (`probe: #106 write characterisation`, `probe: #106
customFields`, `probe: #106 roundtrip`) and all three were deleted with `?everywhere=true`
afterwards; the two pre-existing `probe:` cards were not touched. Every request below went
out through this repo's own axios client, so the credentials, the base URL and the
`organizationId` header are the ones the CLI uses.

Confidence legend, as in `tracker-contract-favro-carriers.md`: **(d) probed** unless said
otherwise. This note records requests, responses and measurements. It decides nothing; what
was built on it is `TxCards.setText` / `setDueDate` / `setFieldValue`.

---

## 0. The finding that reframes the other four

**`PUT /cards/{cardId}` answers with the whole card row, and its key set is IDENTICAL to
`GET /cards/{cardId}`'s.** (d) probed.

Sorted keys of a PUT response body, diffed against the sorted keys of a GET on the same
card minutes later — `onlyOnGet: []`, `onlyOnPut: []`:

```
archived, assignments, attachments, cardCommonId, cardId, columnId, createdAt,
createdByUserId, customFields, dependencies, detailedDescription, favroAttachments,
isLane, listPosition, name, organizationId, parentCardId, position, sequentialId,
sheetPosition, tags, tasksDone, tasksTotal, timeOnBoard, timeOnColumns, widgetCommonId
```

And the echo carries the POST-write state, not a pre-write one: every write below was
observed in its own PUT response and then confirmed by a separate GET, and the two agreed
in every case.

This is measured for the four fields this ticket names. It is **not** a general licence:
the repo's existing "a read-side row is not a write-side echo" notes
(`UpdateCardRequest.columnId`, `CardsAPI.moveCard`, `write-echo-wire.test.ts`) were written
about fields nobody had probed on a PUT, and `columnId` / `widgetCommonId` still have no
measurement of the echo AFTER A WRITE TO THAT FIELD — only of the key's presence in a
response to a write of some OTHER field, which is what §1 and §3 below observed in passing.

---

## 1. `name` — honoured, echoed, byte-exact

Request:

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"name": "probe: #106 renamed"}
```

Response `200`, body carries `"name": "probe: #106 renamed"`. A separate
`GET /cards/{cardId}` agrees.

Three values were sent to test for canonicalisation, each compared byte-for-byte against
both the echo and a following GET:

| sent | echo identical | GET identical |
|---|---|---|
| `"  padded name  "` | yes | yes |
| `"name with **markdown**"` | yes | yes |
| `"plain name"` | yes | yes |

**Measurement:** leading/trailing whitespace survives, markdown syntax is stored literally
and is not parsed. Strict equality against the PUT echo is therefore a legitimate read-back
for `name` — the same standing `archived` earned in #75.

---

## 2. `description` — honoured as `detailedDescription`, and the round trip is LOSSY

The honoured write field is `detailedDescription`; `mapDescription` already rewrites the
key, and `PUT {description}` being a silent no-op was measured earlier (#15/#16/#17). What
was unmeasured, and is the reason `setText` carried no read-back, is whether what you write
is what you get.

### 2.1 Plain text survives byte-for-byte

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"detailedDescription": "plain text, no markdown at all"}
```

Echo identical to the sent string.

### 2.2 Markdown does not — and it is not even idempotent on the first re-write

Sent (`MD`):

```
"# Heading\n\n- bullet **bold**\n- [ ] checkbox\n\n```ts\nconst x = 1;\n```\n\ntrailing text"
```

Echoed, and confirmed identical by a following GET (`R1`):

```
"# Heading\n\n* bullet **bold**\n\n* [\u200b ] checkbox\n\n```\nconst x = 1;\n```\n\ntrailing text"
```

Four transformations, all silent, all on a 200:

1. `-` list markers become `*`.
2. A blank line is inserted between list items.
3. The fenced-block info string is dropped: the opening fence loses its `ts`.
4. A **zero-width space (U+200B) is injected after `[`**, which destroys `- [ ]` checkboxes.

Transformation 4 is the byte-level damage `MARKDOWN_BODY` in `cards-api.ts` records for a
`descriptionFormat` sent in the BODY (#15, #17). It happens here with `descriptionFormat`
correctly on the **query string** as well, so the query-string placement is not a defence
against it. That is a correction to the implication of the existing comment, not to its
stated fact: the body placement was measured to be worse (it escapes the whole body as
literal text); the query-string placement still injects the ZWSP.

Writing `R1` back gives a DIFFERENT string again (`R2`):

```
"# Heading\n\n* bullet **bold**\n\n* \\[\u200b \\] checkbox\n\n```\nconst x = 1;\n```\n\ntrailing text"
```

— the ZWSP-bearing brackets pick up backslash escapes. Writing `R2` back gives `R2`
verbatim (`R3 === R2`), so the transform converges after two passes but the FIRST
re-write of a value read off the card mutates it.

### 2.3 Clearing a description stores `"\n"`, not `""`

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"detailedDescription": ""}
```

`200`; the echo carries `"detailedDescription": "\n"` and so does the following GET. The key
is present, not absent.

### 2.4 Reading without `descriptionFormat` returns a rendered plaintext, not the source

`GET /cards/{cardId}` with no `descriptionFormat` on the same card holding `R1`:

```
"Heading\n• bullet bold\n• [\u200b ] checkbox\nconst x = 1;\ntrailing text\n\n"
```

Headings, emphasis and fences are gone and `*` has become `•`. So the markdown read and the
plain read are different SPACES, and a captured value must never be compared across them.

### 2.5 Consequences

- **A strict-equality read-back on `description` is impossible.** It would throw on every
  markdown write that in fact landed. `setText` therefore still confirms nothing for this
  field, and the reason is now measured rather than unknown.
- **The compensation record must hold the ECHO, not the argument.** `compareBeforeRestore`
  compares `live === record.wrote`; with the argument in `wrote`, every markdown description
  rollback would compare `MD` against a live `R1`, decline to restore, and report a
  `compensation-skipped` orphan for a card nobody else had touched — downgrading a correct
  `rolled-back` to `rollback-incomplete`. Recording the echo (measured to equal what a GET
  returns) makes the compare hold.
- **The inverse of a description write is not byte-exact, and cannot be.** The captured
  prior value is `R1`-shaped and writing it back produces `R2`. Favro offers no write that
  restores a description exactly; this is a limit of the wire, recorded rather than
  papered over.

---

## 3. `dueDate` — one honoured write field, three answers depending on what you send

### 3.1 A date-only write is honoured and NORMALISED on the way in

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"dueDate": "2026-09-01"}
```

`200`, echo `"dueDate": "2026-09-01T00:00:00.000Z"`, GET agrees. **What comes back is not
what was sent** — so strict equality against the argument is the wrong read-back here even
though the echo is present.

The day is preserved: `2026-09-01` in, `2026-09-01` out. No timezone shift was observed on
this key. (`card-predicates.ts` measured 853 dated cards reading as full ISO with a local
day boundary such as `T07:00:00.000Z`; those are UI-written values, and nothing here
contradicts them.)

### 3.2 A full ISO timestamp is ALSO honoured, and is echoed verbatim

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"dueDate": "2026-10-15T07:00:00.000Z"}
```

`200`, echo `"dueDate": "2026-10-15T07:00:00.000Z"`, GET agrees. This closes the open edge
recorded on `UpdateCardRequest.dueDate` — *"whether the write side also accepts an ISO
timestamp is unmeasured"*. It does. The read shape is therefore also a legal write shape,
which is what makes a captured pre-state restorable.

### 3.3 `null` CLEARS the date

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"dueDate": null}
```

`200`, and the echo carries **no `dueDate` key at all**; the following GET carries none
either. Clearing is available and observable.

### 3.4 `""` is a SILENT NO-OP

```
PUT /cards/{cardId}?descriptionFormat=markdown
{"dueDate": ""}
```

`200`, echo `"dueDate": "2026-09-01T00:00:00.000Z"` — the value that was already there.
The GET agrees. Nothing was written and nothing said so.

This is the same family as `PUT {status}`, `PUT {tags:[…]}`, `PUT {assignees:[…]}` and
`PUT {archived}`: a green write that changed nothing. It is the natural spelling for
"clear this" from a CSV column or an empty CLI flag, which is exactly why it is dangerous.

### 3.5 Consequences

Set and clear are both honoured and both observable in the PUT echo, so `setDueDate` can
throw on a 200 that did not take — but it must compare on the **day**, not on the string,
because §3.1 measured the normalisation. `""` is refused up front rather than forwarded.

---

## 4. `customFields` — measured on ONE field type: **Single select**

### 4.1 The field probed

The scratch board carries exactly one enabled custom field, and every card created on the
board is born holding it:

```
GET /customfields/zxMLxD4zx4tSwJr75
200 {"customFieldId":"zxMLxD4zx4tSwJr75","name":"Status","organizationId":"b0b3…541",
     "enabled":true,"type":"Single select",
     "customFieldItems":[{"customFieldItemId":"YLanLiuXKA8JpvEsX","name":"Todo"},
                         {"customFieldItemId":"07ef4afba3a3d76994f5dd74","name":"Doing"},
                         {"customFieldItemId":"0c9ad3f3a19702b994aaff8c","name":"Done"}]}
```

A freshly created card echoes `"customFields":[{"customFieldId":"zxMLxD4zx4tSwJr75",
"value":["YLanLiuXKA8JpvEsX"]}]` — the field has a default and no card on this board is
without it. **No field of any other type exists on this board, so no other type was
measured, and nothing below may be generalised to `Text`, `Number`, `Date`, `Members`,
`Link`, `Checkbox`, `Multiple select`, `Tags` or `Timeline`.** Favro's API exposes no
create-a-custom-field verb this probe could find, so provisioning another type is a UI
action, not a probe step.

### 4.2 The honoured write, and its echo

```
PUT /cards/{cardId}
{"customFields":[{"customFieldId":"zxMLxD4zx4tSwJr75","value":["07ef4afba3a3d76994f5dd74"]}]}
```

`200`, echo `"customFields":[{"customFieldId":"zxMLxD4zx4tSwJr75",
"value":["07ef4afba3a3d76994f5dd74"]}]`, GET agrees. Honoured, and the stored value is
observable in the response.

**Open edge:** the card under test held exactly one custom field, so whether the echoed
`customFields` array is the WHOLE card's field set or only the entries the write touched is
**not settled by this probe**. Any reader of the echo must therefore match on
`customFieldId` rather than take `[0]` — which is what `custom-fields-api.ts` already does.

### 4.3 Three failure modes, all `202` with a message and nothing written

`202` is a SUCCESS status to axios, so none of these throws on its own; each arrived as a
resolved response whose body is `{"message": …}` and which carries **no card row at all**.
A following GET confirmed the stored value was unchanged in all three cases.

| request | response |
|---|---|
| `{"customFields":[{"customFieldId":"zxMLxD4zx4tSwJr75","value":[]}]}` — clear a select | `202 {"message":"Invalid status value"}` |
| `{"customFields":[{"customFieldId":"ZZZZZZZZZZZZZZZZZ","value":["x"]}]}` — unknown field | `202 {"message":"Custom field is not valid"}` |
| `{"customFields":[{"customFieldId":"zxMLxD4zx4tSwJr75","value":"07ef…d74"}]}` — bare string instead of `[optionId]` | `202 {"message":"Match failed"}` |

None of those three messages is in `favro-error.ts`'s closed set, and they are not added
here — widening that set is #58's, and the shape above is enough for a caller to act on:
**a `customFields` write whose response carries no card row did not happen.** The message,
when present, means Favro rejected the request deterministically.

### 4.4 Consequences

- A `customFields` write is confirmable from its own echo, matched on `customFieldId`.
- The measured way to observe failure is the ABSENCE of the card row, plus Favro's message.
- **A `Single select` cannot be cleared by writing `value: []`** (§4.3). So the inverse of a
  write to a field that had no prior value has no measured spelling, and a compensation
  entry for that case must report the failure rather than pretend to undo it.

---

## 5. Summary table

| write | honoured | echo on the PUT | read-back possible | notes |
|---|---|---|---|---|
| `{name}` | yes | yes, byte-exact | **yes, strict equality** | no trimming, no markdown parsing |
| `{detailedDescription}` plain | yes | yes, byte-exact | no — see next row | |
| `{detailedDescription}` markdown | yes | yes, but CANONICALISED | **no** | not idempotent until the 2nd re-write |
| `{detailedDescription: ""}` | yes | echoes `"\n"` | n/a | clears, but stores a newline |
| `{dueDate: "YYYY-MM-DD"}` | yes | yes, as `…T00:00:00.000Z` | **yes, on the day** | normalised on the way in |
| `{dueDate: ISO}` | yes | yes, verbatim | **yes** | closes the #132 open edge |
| `{dueDate: null}` | yes | key absent | **yes** | the only measured clear |
| `{dueDate: ""}` | **no** | echoes the OLD value | n/a | silent no-op |
| `{customFields:[{customFieldId, value:[optionId]}]}` | yes (Single select) | yes | **yes, matched on `customFieldId`** | one type measured, no others |
| the same with `value: []`, a bogus id, or a bare string | **no** | `202 {"message"}`, no card row | **yes, by the missing row** | messages not in the closed set |
