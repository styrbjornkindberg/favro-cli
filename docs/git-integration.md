# Git Integration

Favro CLI bridges your local Git workflow with Favro cards — branch from a card, reference it automatically on commit, and sync branch state back to the board.

---

## Link the Repository to a Board

```bash
favro git link --board abc123
favro git link --board abc123 --prefix CARD --branch-pattern "feature/{{cardId}}-{{slug}}"
```

`git link` connects the **repository to a board**, not a card to a branch. It verifies the board exists and writes `.favro.json` at the project root, recording the board, the optional card-ID prefix, and the optional branch-naming pattern.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | Board to link (required) |
| `--prefix <prefix>` | Card ID prefix, so `CARD` yields `[CARD-123]` commit prefixes |
| `--branch-pattern <pattern>` | Branch naming pattern; `{{cardId}}` and `{{slug}}` are substituted |

## Branch from a Card

```bash
favro git branch abc123               # Creates branch: feature/abc123-<slug>
favro git branch abc123 --no-move     # Create the branch, leave the card alone
```

Records the branch → card mapping in `.favro.json` and moves the card to "In Progress" unless `--no-move` is passed. `-y/--yes` skips the confirmation prompt.

## Commit with Card Reference

```bash
favro git commit -m "Fix auth validation"
# → commit message: "[abc123] Fix auth validation"

favro git commit -m "Fix auth validation" --card abc123 --comment
# → Commits AND posts a comment on the card with the commit hash
```

The card is auto-detected from the `.favro.json` branch mapping, then from the branch name; `--card` overrides both.

| Flag | Description |
|------|-------------|
| `-m, --message <message>` | Commit message (required) |
| `--card <card>` | Card to reference, when it cannot be inferred from the branch |
| `--comment` | Post a comment on the card with the commit hash |
| `--no-prefix` | Do not prepend the card ID to the commit message |

There is no `--move` and no `--assign`: `git commit` commits and optionally comments. Move the card with `favro cards move` or let `favro git sync` do it from the branch state.

## Sync Status

```bash
favro git sync                       # Sync all card-linked branches with branch state
favro git sync --dry-run             # Preview changes
```

Sync reads every branch except the default one and maps it to a card:

- Merged branches → moves the card to "Done"
- Open branches → moves the card to "In Progress"
- The current branch is listed but never moved

Sync never deletes cards and never unlinks branches — it only updates card status.

Sync needs a default branch to compare against: `refs/remotes/origin/HEAD`, or a local `main` or `master`. A repo with none of those — a clone whose default is `develop`, say — refuses instead of guessing `main`, and the remedy is in the refusal (`git remote set-head origin <branch>`). A merge check that cannot run refuses for the same reason: "we could not check" is never reported as *not merged*, because *not merged* is what moves a card to "In Progress".

## Git Todos

```bash
favro git todos                      # List TODO/FIXME/HACK comments in the codebase
favro git todos --create --board abc123   # Turn them into cards on that board
favro git todos --create --dry-run   # Preview the cards first
```

`git todos` scans the **codebase**, not the board. Without `--create` it just lists what it found; `--limit <n>` caps the listing (default 100). With `--create`, the board comes from `--board` or, failing that, the board recorded by `favro git link`.

---

## How It Works

1. **Link storage**: `.favro.json` records the linked board and maps branches ↔ card IDs
2. **Commit messages**: `favro git commit` prefixes the card ID itself (`--no-prefix` opts out) — there is no git hook to install
3. **Branch naming**: `feature/<cardId>-<slugified-title>` by default, or `--branch-pattern` from `git link`
4. **Safety**: `sync` never deletes cards — only updates column/status

## Typical Workflow

```bash
# Once per repository
favro git link --board abc123

# Pick your next card
favro next

# Create a branch from it
favro git branch abc123

# Work... commit with card reference
favro git commit -m "Implement feature"

# After merge, sync all links
favro git sync
```
