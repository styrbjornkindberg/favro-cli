<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/node-18%2B-brightgreen" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="license">
</p>

<h1 align="center">favro-cli</h1>
<p align="center">
  Give your AI assistant full access to your <a href="https://favro.com">Favro</a> boards.<br>
  Install once, then just talk to your LLM.
</p>

---

## What is this?

favro-cli is a command-line tool that lets your AI assistant (Claude, ChatGPT, etc.) read and manage your Favro boards. Once installed and configured, you don't type commands yourself — you describe what you want in plain language, and the LLM does it for you.

> **The LLM uses the CLI behind the scenes. You just have a conversation.**

---

## What can your LLM do for you?

Here are five real examples. Each shows a conversation with an LLM that has favro-cli installed.

---

### 1. Summarize a messy card

Cards grow. Long descriptions, ten comment threads, status changes nobody documented. Instead of reading through all of it:

> **You:** There's a card called "Migrate auth service to OAuth2" — can you give me a quick summary of where things stand and what people have said about it?
>
> **LLM:** Let me pull that card up.
>
> *(runs `favro query "Sprint Board" "Migrate auth service to OAuth2"` to find the card, then `favro cards get <id> --json` and `favro comments list <id>`)*
>
> **LLM:** Here's where things stand:
>
> **Card summary:** The migration was originally planned for Q4 but got blocked when the identity provider changed their token format. The description outlines three phases: token exchange, session migration, and client-side changes.
>
> **What people have said:**
> - Alice flagged that the identity provider's new format breaks the current token validation (Nov 3)
> - Bob said the session migration is ready and waiting on Alice's fix
> - Alice confirmed the fix is merged, but the client-side changes are still unassigned
>
> **Current status:** The card is sitting in "In Progress" but effectively blocked on client-side work. Nobody is assigned to that part. Want me to flag it as blocked or assign it to someone?

---

### 2. Break a big card into smaller ones

A card that's too broad to finish in a sprint. Instead of doing it yourself:

> **You:** The card "Redesign checkout flow" is way too big. Can you split it into smaller cards on the same board and link them back to the original?
>
> **LLM:** I'll read the card first to understand the scope.
>
> *(runs `favro cards get <id> --json`)*
>
> **LLM:** Based on the description, I can see at least five distinct pieces of work here. Here's what I'd create as separate cards, all linked to the original:
>
> 1. "Checkout: New address form UI"
> 2. "Checkout: Payment method selection redesign"
> 3. "Checkout: Order summary component"
> 4. "Checkout: Mobile responsive layout"
> 5. "Checkout: A/B test for CTA button placement"
>
> I'll use `--dry-run` first so you can see what happens before I create anything. Ready?
>
> **You:** Looks good, go ahead.
>
> **LLM:** *(creates the five cards and links each to the parent with `favro cards link`)*
>
> Done. Five cards created in "Sprint Board" and linked to "Redesign checkout flow". The original card is now the parent. Want me to move them all to Backlog, or leave them in their default column?

---

### 3. Add a checklist to a card from its description

A card has a vague description that should really be a step-by-step checklist:

> **You:** The card "Deploy v3.2 to production" has a description with all the deployment steps listed as bullet points. Can you convert those into actual checklist items on the card?
>
> **LLM:** I'll read the card first.
>
> *(runs `favro cards get <id> --json`)*
>
> **LLM:** I found 8 steps in the description. Here's what I'd create as checklist items:
>
> - [ ] Merge release branch into main
> - [ ] Run full test suite
> - [ ] Build production Docker image
> - [ ] Push image to registry
> - [ ] Update Kubernetes config
> - [ ] Deploy to staging, verify smoke tests
> - [ ] Deploy to production
> - [ ] Monitor error rate for 30 minutes
>
> Should I add these as a checklist called "Deployment Steps"?
>
> **You:** Yes please.
>
> **LLM:** *(runs `favro tasklists create` to add a new checklist, then `favro tasks add` for each item)*
>
> Done. Eight checklist items added under "Deployment Steps". The original description text is still there — want me to clean it up to avoid duplication?

---

### 4. Find and fix broken dependencies between cards

Cards that block each other but nobody set up the actual links, or old links that no longer make sense:

> **You:** I think there are a bunch of cards in the Sprint board that mention being blocked by other cards in the comments, but the actual dependency links aren't set up. Can you find them and fix it?
>
> **LLM:** I'll scan comments and descriptions across the board for any mention of blocking relationships.
>
> *(runs `favro context "Sprint Board" --json` to get all cards, then reads each card's comments)*
>
> **LLM:** Found four unlinked dependencies:
>
> | Card | Says it's blocked by |
> |------|----------------------|
> | "API rate limiting" | "Auth token refresh" |
> | "Mobile push notifications" | "Device registration endpoint" |
> | "Analytics dashboard" | "Event tracking v2" |
> | "Email digest" | "User preference API" |
>
> None of these have actual dependency links set up in Favro. Want me to add them? I'll use `--dry-run` first.
>
> **You:** Yes, dry run first then go.
>
> **LLM:** *(previews changes, then runs `favro dependencies add` for each pair)*
>
> Done. Four "blocks" links added. The blocked cards will now show up correctly in the dependency view.

---

### 5. Turn a planning document into cards

You have meeting notes, a spec doc, or a list of action items. Instead of manually creating cards one by one:

> **You:** Here's the output from our planning meeting. Can you create the cards we need? *(pastes document)*
>
> ```
> Q2 Planning — Key initiatives
>
> Infrastructure
> - Set up staging environment with production parity
> - Migrate CI pipeline from Jenkins to GitHub Actions
> - Implement automated DB backups with point-in-time recovery
>
> Product
> - Redesign onboarding flow based on user research (owner: Sarah)
> - Add SSO support for enterprise customers (blocks: pricing page update)
> - Launch mobile app beta (due: end of May)
>
> Bugs to prioritize
> - Fix session timeout on Safari (reported by 3 enterprise clients)
> - Address memory leak in background job processor
> ```
>
> **LLM:** I can see 8 cards here across three groups. Before I create anything, a few questions:
>
> 1. Which board should these go on?
> 2. Should the groups (Infrastructure, Product, Bugs) become tags, or just go into the same column?
> 3. "SSO support" says it blocks "pricing page update" — is that card already on the board, or should I create it too?
>
> **You:** Use the "Q2 Backlog" board. Use tags for the groups. The pricing page card already exists.
>
> **LLM:** Got it. I'll dry-run first.
>
> *(runs `favro boards list`, finds the board, checks for the existing "pricing page update" card, previews 8 card creations)*
>
> **LLM:** Here's what I'll create — 8 cards with appropriate tags. "SSO support" will be linked to the existing pricing page card. Ready?
>
> **You:** Go.
>
> **LLM:** *(creates all 8 cards with tags, assigns Sarah to the onboarding card, sets a due date on mobile app beta, links the dependency)*
>
> Done. 8 cards created on "Q2 Backlog". Sarah is assigned to the onboarding card, mobile app beta has a May 31 due date, and the SSO → pricing page dependency is set up.

---

## Setup

### 1. Install

Requires **Node.js 18+**.

```bash
git clone https://github.com/styrbjornkindberg/favro-cli.git
cd favro-cli
npm install && npm run build && npm link
```

### 2. Connect to Favro

```bash
favro auth login
```

This will ask for your Favro API token (find it in Favro → your avatar → Profile → API Tokens).

### 3. Give your LLM the skill

The LLM needs to know how to use the CLI safely. The skill file is the instruction set that teaches the LLM which commands to run, how to stay safe, and how to confirm changes with you before making them.

See the **[LLM Tool Setup](#llm-tool-setup)** section below for instructions specific to your tool.

### 4. Set a scope (recommended)

Tell the CLI which collection it's allowed to write to. This prevents accidental changes to other projects.

```bash
favro collections list        # Find your collection ID
favro scope set <id>          # Lock writes to that collection
```

---

## LLM Tool Setup

Open the favro-cli folder in your favorite LLM coding tool (Claude Code, Cursor, Windsurf, Gemini CLI, etc.) and ask it:

```
Install the favro-cli skill for yourself. The skill is at
skills/favro-cli/ in this directory (including the references/
subfolder). Copy it to wherever you load instructions from
automatically, so you'll have it in every future session.
```

The LLM knows where it keeps its own instruction files. It will install the skill for itself and confirm when it's ready.

---

## How the LLM stays safe

The CLI has three built-in safety layers that the LLM is instructed to use:

| Layer | What it does |
|-------|-------------|
| **Scope lock** | Writes are blocked outside the collection you specify |
| **Dry-run** | Every write is previewed before executing |
| **Confirmation** | The LLM shows you what it plans to do and asks before acting |

The LLM will always `--dry-run` first, show you the result, and wait for you to say go.

---

## If you prefer typing commands yourself

The CLI works fine without an LLM. See the **[Command Reference](./docs/commands.md)** for everything.

Quick examples:

```bash
favro                                          # Interactive menu
favro board "Sprint 42"                       # Kanban view in terminal
favro cards create "Fix bug" --board <id>     # Create a card
favro my-cards                                # Your cards across all boards
favro health                                  # Board health scores
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No API key configured` | Run `favro auth login` |
| `API key is invalid` | Favro → avatar → Profile → API Tokens → regenerate |
| `Scope violation` | Run `favro scope show` — you're writing outside the locked collection |
| `--column` not working | You need `--board <id>` alongside `--column` |
| Network errors | Run `favro auth verify` to test the connection |

Add `--verbose` to any command for full debug output.

---

## Documentation

| Document | Description |
|----------|-------------|
| **[Installation Guide](./INSTALL.md)** | Detailed setup, npm link, troubleshooting |
| **[Command Reference](./docs/commands.md)** | Every command, flag, and option |
| **[Git Integration](./docs/git-integration.md)** | Branch↔card linking, smart commits, sync |
| **[Repo Context](./docs/repo-context.md)** | `.favro/context.json` — give LLMs instant board context |
| **[Examples & Workflows](./EXAMPLES.md)** | More command patterns |

---

## License

See [LICENSE](./LICENSE).
