# Installation Guide

Get Favro CLI running on your system in under 5 minutes.

---

## System Requirements

- **Node.js 18.0.0 or later** ([Download](https://nodejs.org/))
- **npm 9.0.0 or later** (included with Node.js)
- **macOS, Linux, or Windows** (any OS that runs Node.js)
- **Favro API key** (see [Getting Your API Key](#getting-your-api-key))

### Check Your Prerequisites

```bash
# Verify Node.js version (should be 18+)
node --version

# Verify npm version
npm --version
```

If you get "command not found", [download Node.js](https://nodejs.org/) and install it.

---

## Getting Your API Key

Before installing, you need a Favro API key:

1. Log in to [favro.com](https://favro.com)
2. Click your **Profile** (top-right)
3. Go to **Organization Settings** → **API tokens**
4. Click **Generate** to create a new token
5. **Copy the token** (you'll need it in 2 minutes)

**Note:** Keep this key private — never commit it to version control or share it.

---

## Installation (3 Steps)

### Step 1: Install the CLI

```bash
npm install -g @square-moon/favro-cli
```

This adds the `favro` command to your system path.

**Verify installation:**

```bash
favro --version
```

You should see a version number. If you get "command not found", see [Troubleshooting](#troubleshooting-npm-path).

### Step 2: Authenticate

Save your Favro API key. Choose one:

**Interactive (recommended — prompts for key):**

```bash
favro auth login
```

**Non-interactive (paste key directly):**

```bash
favro auth login --api-key YOUR_API_KEY_HERE
```

**Environment variable (for scripts/CI):**

```bash
export FAVRO_API_KEY=your_api_key_here
```

Your key is saved to `~/.favro/config.json` (mode `0600` — only you can read it).

### Step 3: Verify Setup

```bash
favro auth check
```

If successful, you'll see: `✓ API key is valid`

---

## First Run: List Your Boards

```bash
favro boards list
```

This fetches all boards from your Favro workspace. You should see output like:

```
ID                      Name          Status
abc123def456           Q1 Planning   active
xyz789abc012           Engineering   active
```

If you see boards, **you're ready to go!** Proceed to [Common Workflows](./EXAMPLES.md).

---

## Troubleshooting

### I see "command not found: favro"

**Cause:** npm didn't add the CLI to your PATH.

**Fix:**
```bash
# Find where npm installed it
npm list -g @square-moon/favro-cli

# Verify npm's bin directory is in your PATH
echo $PATH | grep -i npm

# If missing, add npm's global bin to ~/.zshrc (or ~/.bashrc for bash):
export PATH="/usr/local/bin:$PATH"

# Then reload shell
source ~/.zshrc
```

Or reinstall:
```bash
npm uninstall -g @square-moon/favro-cli
npm install -g @square-moon/favro-cli
favro --version
```

### I see "Error: Request failed with status code 404"

**Cause:** Usually means your API key is missing or invalid.

**Fix:**
1. Verify your key was saved:
   ```bash
   cat ~/.favro/config.json
   ```
   You should see `{"token": "..."}`.

2. If missing, run:
   ```bash
   favro auth login --api-key YOUR_KEY_HERE
   ```

3. Verify the key:
   ```bash
   favro auth check
   ```

### I see "Error: Cannot find module"

**Cause:** Incomplete or corrupted installation.

**Fix:**
```bash
# Uninstall and reinstall
npm uninstall -g @square-moon/favro-cli
npm install -g @square-moon/favro-cli

# Verify
favro --version
```

### I get "Checking API key... Error: Request failed"

**Cause:** Network issue or invalid API key.

**Fix:**
1. Check your internet connection:
   ```bash
   ping favro.com
   ```

2. Verify your API key in Favro:
   - Log in to [favro.com](https://favro.com)
   - Go to **Organization Settings** → **API tokens**
   - Ensure your token hasn't expired or been revoked

3. Re-authenticate:
   ```bash
   favro auth login --api-key YOUR_NEW_KEY_HERE
   ```

### My key works in Favro's web UI but not the CLI

**Cause:** Possible token expiration or permission issue.

**Fix:**
1. Generate a **new token** in Favro settings
2. Save it:
   ```bash
   favro auth login --api-key YOUR_NEW_KEY_HERE
   ```
3. Verify:
   ```bash
   favro auth check
   ```

### I see "EACCES: permission denied"

**Cause:** npm doesn't have permission to write to global directories.

**Fix:**
```bash
# Option 1: Run with sudo (not recommended)
sudo npm install -g @square-moon/favro-cli

# Option 2: Fix npm permissions (recommended)
# See: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
export PATH=~/.npm-global/bin:$PATH
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.zshrc
```

---

## Next Steps

- **[Common Workflows](./EXAMPLES.md)** — Real-world usage examples
- **[README](./README.md)** — Full feature reference and command documentation
- **[Support](#troubleshooting)** — Additional help

Happy tasking! 🎯
