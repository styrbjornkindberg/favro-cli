# Git Integration

Favro CLI bridges your local Git workflow with Favro cards — link branches to cards, auto-update status on commit, and keep everything in sync.

---

## Link a Card to a Branch

```bash
favro git link <cardId>              # Link current branch → card
favro git link <cardId> --branch feature/login
```

Creates a two-way association stored in `.favro/git-links.json`. The card gets a comment noting the branch link.

## Branch from a Card

```bash
favro git branch <cardId>            # Creates branch: favro/<card-seq>-<slug>
favro git branch <cardId> --prefix feature/
```

Automatically links the new branch to the card.

## Commit with Card Reference

```bash
favro git commit <cardId> "Fix auth validation"
# → commit message: "[FAV-123] Fix auth validation"

favro git commit <cardId> "Done" --move Review
# → Commits AND moves card to Review column
```

| Flag | Description |
|------|-------------|
| `--move <status>` | Move card to column after commit |
| `--assign` | Self-assign the card |

## Sync Status

```bash
favro git sync                       # Sync all linked cards with branch state
favro git sync --dry-run             # Preview changes
```

Sync detects:
- Merged branches → moves card to Done
- Deleted branches → unlinks card
- Active branches → keeps as In Progress

## Git Todos

```bash
favro git todos                      # Show cards linked to current branch
favro git todos --all                # Show all linked cards across branches
```

---

## How It Works

1. **Link storage**: `.favro/git-links.json` maps branches ↔ card IDs
2. **Commit hooks**: Optional — `favro git install-hooks` adds a prepare-commit-msg hook
3. **Branch naming**: `favro/<seq>-<slugified-title>` by default
4. **Safety**: `sync` never deletes cards — only updates column/status

## Typical Workflow

```bash
# Pick your next card
favro next

# Create a branch from it
favro git branch abc123

# Work... commit with card reference
favro git commit abc123 "Implement feature"

# When done, move card
favro git commit abc123 "Final cleanup" --move Review

# After merge, sync all links
favro git sync
```
