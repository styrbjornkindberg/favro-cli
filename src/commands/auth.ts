/**
 * Auth Commands for Favro CLI
 * CLA-1773: Configuration & Auth Setup
 *
 * Commands:
 *   favro auth login   — prompts for API key, saves to config
 *   favro auth logout  — removes API key from config
 *   favro auth check   — validates API key against Favro API (alias for verify)
 *   favro auth verify  — validates API key against Favro API (spec-compliant name)
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import * as readline from 'readline';
import { readConfig, writeConfig, CONFIG_FILE, resolveApiKey } from '../lib/config';

import { logError } from '../lib/error-handler';

/**
 * Prompt user for input interactively.
 * Exported for testing.
 */
export async function promptInput(question: string, masked: boolean = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (masked) {
      // Mute output while user types the key
      const write = (rl as any).output?.write?.bind((rl as any).output);
      if (write) {
        (rl as any).output.write = () => {};
      }
      rl.question(question, (answer) => {
        if (write) {
          (rl as any).output.write = write;
          process.stdout.write('\n');
        }
        rl.close();
        resolve(answer.trim());
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

/**
 * Validate an API key by making a test request to Favro API.
 * Returns true if valid, false if unauthorized.
 * Throws for unexpected errors.
 */
export async function validateApiKey(apiKey: string, email: string): Promise<boolean> {
  try {
    const client = new FavroHttpClient({ auth: { token: apiKey, email } });
    await client.get('/organizations');
    return true;
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      return false;
    }
    // Network errors or 5xx — re-throw so user gets a useful message
    throw err;
  }
}

/**
 * Shared verify logic used by both `auth verify` and `auth check`.
 * Uses resolveApiKey() for consistent priority across all commands.
 */
async function runVerify(options: { apiKey?: string }, verbose = false): Promise<void> {
  let apiKey: string | undefined;
  let email: string | undefined;
  try {
    const auth = await (await import('../lib/config')).resolveAuth({ apiKey: options.apiKey });
    apiKey = auth.token;
    email = auth.email;
  } catch (err: any) {
    logError(err, verbose);
    process.exit(1);
  }

  if (!apiKey) {
    console.error('Error: API key not found. Run `favro auth login` first');
    process.exit(1);
  }

  if (!email) {
    console.error('Error: Email not configured. Run `favro auth login` first');
    process.exit(1);
  }

  console.log('Checking API key...');
  try {
    const valid = await validateApiKey(apiKey, email);
    if (valid) {
      console.log('✓ API key is valid');
    } else {
      console.error('✗ API key is invalid or unauthorized.');
      console.error('  Get a new key at: https://favro.com/ → Organization Settings → API tokens');
      process.exit(1);
    }
  } catch (err: any) {
    logError(err, verbose);
    process.exit(1);
  }
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  // ─── auth login ─────────────────────────────────────────────────────────────
  auth
    .command('login')
    .description('Set up your Favro credentials (email + API key)')
    .option('--api-key <key>', 'API key to save (skip interactive prompt)')
    .option('--email <email>', 'Email address to save (skip interactive prompt)')
    .action(async (options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      let apiKey = options.apiKey as string | undefined;
      let email = options.email as string | undefined;

      console.log('Favro CLI — Authentication Setup');
      console.log('─'.repeat(40));

      if (!email) {
        console.log('Enter the email address associated with your Favro account.');
        email = await promptInput('Email: ', false);
      }
      if (!email || email.length === 0) {
        console.error('✗ No email provided.');
        process.exit(1);
      }

      if (!apiKey) {
        console.log('\nEnter your Favro API token.');
        console.log('Generate one at: https://favro.com/ → Profile → API tokens\n');
        apiKey = await promptInput('API token: ', true);
      }
      if (!apiKey || apiKey.length === 0) {
        console.error('✗ No API key provided.');
        process.exit(1);
      }

      // Validate credentials before saving
      process.stdout.write('\nValidating credentials...');
      try {
        const valid = await validateApiKey(apiKey, email);
        if (!valid) {
          process.stdout.write(' ✗\n');
          console.error('✗ Invalid credentials. Check your email and API token and try again.');
          process.exit(1);
        }
        process.stdout.write(' ✓\n');
      } catch (err: any) {
        process.stdout.write(' ✗\n');
        logError(err, verbose);
        process.exit(1);
      }

      // Auto-discover organization ID
      let organizationId: string | undefined;
      try {
        process.stdout.write('Fetching organization...');
        const client = new FavroHttpClient({ auth: { token: apiKey, email } });
        const response = await client.get<{ entities: Array<{ organizationId: string; name: string }> }>('/organizations');
        const orgs = response.entities ?? [];

        if (orgs.length === 0) {
          process.stdout.write(' ⚠\n');
          console.warn('⚠  No organizations found for this account. You can set FAVRO_ORGANIZATION_ID manually.');
        } else if (orgs.length === 1) {
          organizationId = orgs[0].organizationId;
          process.stdout.write(` ✓ (${orgs[0].name})\n`);
        } else {
          process.stdout.write('\n');
          console.log('\nMultiple organizations found:');
          orgs.forEach((org: { organizationId: string; name: string }, i: number) => console.log(`  ${i + 1}. ${org.name} (${org.organizationId})`));
          const pick = await promptInput(`\nSelect organization [1-${orgs.length}]: `, false);
          const idx = parseInt(pick, 10) - 1;
          if (idx >= 0 && idx < orgs.length) {
            organizationId = orgs[idx].organizationId;
            console.log(`✓ Using: ${orgs[idx].name}`);
          } else {
            console.error('✗ Invalid selection.');
            process.exit(1);
          }
        }
      } catch (err: any) {
        process.stdout.write(' ✗\n');
        logError(err, verbose);
        process.exit(1);
      }

      // Save everything to config
      try {
        const existing = await readConfig();
        const updated = { ...existing, apiKey, email, ...(organizationId ? { organizationId } : {}) };
        await writeConfig(updated);
        console.log(`\n✓ Credentials saved to ${CONFIG_FILE}`);
        if (!organizationId) {
          console.log('  ⚠  Organization ID not saved. Set FAVRO_ORGANIZATION_ID or re-run `favro auth login`.');
        }
      } catch (err: any) {
        logError(err, verbose);
        process.exit(1);
      }
    });

  // ─── auth logout ────────────────────────────────────────────────────────────
  // Fix (Issue 4): implement logout command as required by spec
  auth
    .command('logout')
    .description('Remove saved API key from config')
    .action(async () => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const existing = await readConfig();
        if (!existing.apiKey) {
          console.log('ℹ No API key stored in config.');
          return;
        }
        const { apiKey: _removed, ...rest } = existing;
        await writeConfig(rest);
        console.log(`✓ API key removed from ${CONFIG_FILE}`);
      } catch (err: any) {
        logError(err, verbose);
        process.exit(1);
      }
    });

  // ─── auth verify ─────────────────────────────────────────────────────────────
  // Fix (Issue 4): add `auth verify` as spec-compliant command name
  auth
    .command('verify')
    .description('Verify your API key is valid (spec-compliant name)')
    .option('--api-key <key>', 'API key to check (overrides config/env)')
    .action(async (options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      await runVerify(options, verbose);
    });

  // ─── auth check ─────────────────────────────────────────────────────────────
  // Fix (Issue 3): use resolveApiKey() via shared runVerify() for consistent priority
  auth
    .command('check')
    .description('Verify your API key is valid')
    .option('--api-key <key>', 'API key to check (overrides config/env)')
    .action(async (options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      await runVerify(options, verbose);
    });
}

export default registerAuthCommand;
