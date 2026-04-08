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

```diff
+ you  There's a card called "Migrate auth service to OAuth2" — can you give me
+      a quick summary of where things stand and what people have said about it?

  llm  Let me pull that card up.

       $ favro query "Sprint Board" "Migrate auth service to OAuth2"
       $ favro cards get <id> --json
       $ favro comments list <id>

       The migration was planned for Q4 but got blocked when the identity
       provider changed their token format. Three phases: token exchange,
       session migration, and client-side changes.

       Comments:
         Alice (Nov 3)  — new token format breaks current validation
         Bob            — session migration is ready, waiting on Alice's fix
         Alice          — fix is merged, client-side changes still unassigned

       The card is In Progress but effectively blocked. Nobody is assigned
       to the client-side work. Want me to flag it as blocked or assign it?
```

---

### 2. Break a big card into smaller ones

A card that's too broad to finish in a sprint. Instead of doing it yourself:

```diff
+ you  The card "Redesign checkout flow" is way too big. Can you split it into
+      smaller cards on the same board and link them back to the original?

  llm  $ favro cards get <id> --json

       I can see five distinct pieces of work. Here's what I'd create,
       all linked back to the original:

         1. Checkout: New address form UI
         2. Checkout: Payment method selection redesign
         3. Checkout: Order summary component
         4. Checkout: Mobile responsive layout
         5. Checkout: A/B test for CTA button placement

       Running --dry-run first. Ready to proceed?

+ you  Looks good, go ahead.

  llm  $ favro cards create "Checkout: New address form UI" --board <id> --yes
       $ favro cards create "Checkout: Payment method selection redesign" --board <id> --yes
       $ favro cards create "Checkout: Order summary component" --board <id> --yes
       $ favro cards create "Checkout: Mobile responsive layout" --board <id> --yes
       $ favro cards create "Checkout: A/B test for CTA button placement" --board <id> --yes
       $ favro cards link <new-id-1> <parent-id> --type child --yes
       ...

       Done. Five cards created and linked to "Redesign checkout flow".
       Want me to move them all to Backlog, or leave them in the default column?
```

---

### 3. Add a checklist to a card from its description

A card has a vague description that should really be a step-by-step checklist:

```diff
+ you  The card "Deploy v3.2 to production" has all the deployment steps in the
+      description as bullet points. Can you convert those into actual checklist
+      items on the card?

  llm  $ favro cards get <id> --json

       Found 8 steps. Here's what I'd add as a checklist called "Deployment Steps":

         [ ] Merge release branch into main
         [ ] Run full test suite
         [ ] Build production Docker image
         [ ] Push image to registry
         [ ] Update Kubernetes config
         [ ] Deploy to staging, verify smoke tests
         [ ] Deploy to production
         [ ] Monitor error rate for 30 minutes

       Shall I create it?

+ you  Yes please.

  llm  $ favro tasklists create <card-common-id> --name "Deployment Steps" --yes
       $ favro tasks add <card-id> "Merge release branch into main" --yes
       $ favro tasks add <card-id> "Run full test suite" --yes
       ...

       Done. Eight checklist items added under "Deployment Steps".
       The original description text is still there — want me to clean it up?
```

---

### 4. Find and fix broken dependencies between cards

Cards that block each other but nobody set up the actual links:

```diff
+ you  I think there are cards in the Sprint board that mention being blocked by
+      other cards in the comments, but the dependency links aren't actually set
+      up. Can you find them and fix it?

  llm  $ favro context "Sprint Board" --json
       $ favro comments list <id>   # repeated for each card

       Found four unlinked dependencies:

         "API rate limiting"          blocked by  "Auth token refresh"
         "Mobile push notifications"  blocked by  "Device registration endpoint"
         "Analytics dashboard"        blocked by  "Event tracking v2"
         "Email digest"               blocked by  "User preference API"

       None have actual dependency links in Favro. Running --dry-run first.

+ you  Looks right, go ahead.

  llm  $ favro dependencies add <api-rate-id> <auth-token-id> --type blocks --yes
       $ favro dependencies add <push-notif-id> <device-reg-id> --type blocks --yes
       $ favro dependencies add <analytics-id> <event-tracking-id> --type blocks --yes
       $ favro dependencies add <email-digest-id> <user-pref-id> --type blocks --yes

       Done. Four "blocks" links added. They'll now show up correctly in the
       dependency view.
```

---

### 5. Turn a planning document into cards

You have meeting notes, a spec doc, or a list of action items. Instead of manually creating cards one by one:

```diff
+ you  Here's the output from our planning meeting. Can you create the cards?
+
+      Q2 Planning — Key initiatives
+
+      Infrastructure
+      - Set up staging environment with production parity
+      - Migrate CI pipeline from Jenkins to GitHub Actions
+      - Implement automated DB backups with point-in-time recovery
+
+      Product
+      - Redesign onboarding flow based on user research (owner: Sarah)
+      - Add SSO support for enterprise customers (blocks: pricing page update)
+      - Launch mobile app beta (due: end of May)
+
+      Bugs to prioritize
+      - Fix session timeout on Safari (reported by 3 enterprise clients)
+      - Address memory leak in background job processor

  llm  I see 8 cards across three groups. A few questions before I create anything:

         1. Which board should these go on?
         2. Should the groups become tags, or just the same column?
         3. "SSO support" blocks "pricing page update" — does that card exist already?

+ you  Use "Q2 Backlog". Tags for the groups. Pricing page card already exists.

  llm  $ favro boards list --json
       $ favro query "Q2 Backlog" "pricing page update"   # find existing card id

       Found the pricing page card. Here's what I'll create — 8 cards with tags,
       Sarah assigned to onboarding, mobile beta due May 31, SSO linked to pricing.
       Running --dry-run first. Proceed?

+ you  Go.

  llm  $ favro cards create "Set up staging environment" --board <id> --tag Infrastructure --yes
       $ favro cards create "Migrate CI to GitHub Actions" --board <id> --tag Infrastructure --yes
       ...
       $ favro cards create "Add SSO support" --board <id> --tag Product --yes
       $ favro dependencies add <sso-id> <pricing-id> --type blocks --yes
       $ favro members add sarah@company.com --to <onboarding-id> --yes

       Done. 8 cards created on "Q2 Backlog". Sarah is assigned to onboarding,
       mobile beta is due May 31, and SSO → pricing page dependency is set up.
```

---

## Setup

### Option A — Let your LLM do it

Open your LLM coding tool (Claude Code, Cursor, Windsurf, Gemini CLI, etc.) and paste this:

```
I want to set up favro-cli so you can help me manage our Favro boards.

Please:
1. Clone https://github.com/styrbjornkindberg/favro-cli.git and install it
   (requires Node.js 18+ — install that too if it's missing).
2. Run `favro auth login` and walk me through getting my Favro API token.
3. Install your own skill file from skills/favro-cli/ so you know how to
   use the tool safely in future sessions.
4. Help me set a scope so writes are locked to the right collection.
```

The LLM will handle Node, the install, and the skill — just follow along.

---

### Option B — Do it yourself

#### 1. Install

Requires **Node.js 18+**.

```bash
git clone https://github.com/styrbjornkindberg/favro-cli.git
cd favro-cli
npm install && npm run build && npm link
```

#### 2. Connect to Favro

```bash
favro auth login
```

This will ask for your Favro API token (find it in Favro → your avatar → Profile → API Tokens).

#### 3. Give your LLM the skill

See the **[LLM Tool Setup](#llm-tool-setup)** section below.

#### 4. Set a scope (recommended)

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
