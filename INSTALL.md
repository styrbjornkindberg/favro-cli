# Installation Guide

Complete setup for `favro-cli` in 5 minutes.

---

## Prerequisites

Before you begin, ensure you have:

- **Node.js 18 or higher** ([Download Node.js](https://nodejs.org/))
  - Check your version: `node --version`
  - If you need to upgrade, follow the [Node.js download page](https://nodejs.org/) for your OS
- **npm** (included with Node.js)
  - Check your version: `npm --version`
- **A Favro account** with API access
  - You'll need your organization's API token (see [Getting Your API Key](#getting-your-api-key))

---

## Installation Steps

### 1. Install the CLI

```bash
npm install -g @square-moon/favro-cli
```

This makes the `favro` command available globally on your system.

### 2. Verify Installation

```bash
favro --version
```

You should see the CLI version number. Example:

```
@square-moon/favro-cli/0.1.0
```

---

## Getting Your API Key

### Step 1: Log In to Favro

Go to [favro.com](https://favro.com) and log in with your account.

### Step 2: Navigate to API Settings

1. Click your **profile icon** (top-right)
2. Select **Organization Settings**
3. Navigate to **Integrations** → **API tokens**

### Step 3: Generate a Token

1. Click **Create new token**
2. Give it a name (e.g., `favro-cli`)
3. Click **Create**
4. **Copy the token immediately** — you won't be able to view it again

---

## Setting Up Authentication

### Interactive Setup (Recommended)

```bash
favro auth login
```

This will:
1. Prompt you for your API key
2. Save it securely to `~/.favro/config.json`
3. Confirm the key works by testing the API

### Non-Interactive Setup (for Scripts/CI)

```bash
favro auth login --api-key YOUR_API_KEY_HERE
```

Or set an environment variable (not persisted):

```bash
export FAVRO_API_KEY=YOUR_API_KEY_HERE
```

### Verify Your Setup

```bash
favro auth check
```

Expected output:

```
✓ API key is valid
```

---

## Troubleshooting

### `command not found: favro`

The CLI is installed but not in your PATH. Try:

```bash
# Verify the global npm bin directory
npm config get prefix

# If not in PATH, reinstall with explicit location
npm install -g @square-moon/favro-cli
```

---

### `Error: No API key configured`

You haven't set up authentication yet. Run:

```bash
favro auth login
```

And follow the prompts.

---

### `Error: API key is invalid`

Your key may have:
- Been revoked or expired
- Been typed incorrectly
- Expired (check Favro API token settings)

To fix:
1. Go to Favro → **API tokens**
2. Generate a new token
3. Run `favro auth login` and paste the new key

---

### `EACCES: permission denied` during install

You're trying to install globally without permissions. Fix with:

```bash
# Option 1: Use sudo (not recommended)
sudo npm install -g @square-moon/favro-cli

# Option 2: Fix npm permissions (recommended)
# See: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-npm-packages-globally
```

---

### Network timeout or `ECONNREFUSED`

The CLI couldn't reach Favro's API. Check:

1. **Internet connection:** Run `ping favro.com`
2. **Firewall:** Ensure port 443 (HTTPS) is not blocked
3. **Proxy:** If behind a corporate proxy, set environment variables:
   ```bash
   export HTTPS_PROXY=https://proxy.example.com:8080
   export HTTP_PROXY=http://proxy.example.com:8080
   ```

---

### `Error: ENOTFOUND config.json`

Your config directory doesn't exist. Create it:

```bash
mkdir -p ~/.favro
```

Then run `favro auth login` again.

---

## Uninstall

To remove the CLI:

```bash
npm uninstall -g @square-moon/favro-cli
```

To remove your saved config:

```bash
rm ~/.favro/config.json
```

---

## Next Steps

Once installed and authenticated:

1. **List your boards:** `favro boards list`
2. **Learn the commands:** `favro --help`
3. **See examples:** Check the [Examples](./EXAMPLES.md) guide
4. **Read the full docs:** See [README.md](./README.md)

---

## Getting Help

- **Command help:** `favro <command> --help`
- **Full documentation:** [README.md](./README.md)
- **Examples:** [EXAMPLES.md](./EXAMPLES.md)
- **Issues:** [GitHub issues](https://github.com/square-moon/favro-cli/issues)
