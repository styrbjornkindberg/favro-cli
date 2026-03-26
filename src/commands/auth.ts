/**
 * Auth Commands for Favro CLI
 * CLA-1773: Configuration & Auth Setup
 *
 * Commands:
 *   favro auth login   — prompts for API key, saves to config
 *   favro auth check   — validates API key against Favro API
 */
import { Command } from 'commander';
import * as readline from 'readline';
import { readConfig, writeConfig, CONFIG_FILE } from '../lib/config';
import FavroHttpClient from '../lib/http-client';

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
export async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const client = new FavroHttpClient({ auth: { token: apiKey } });
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

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  // ─── auth login ─────────────────────────────────────────────────────────────
  auth
    .command('login')
    .description('Set up your Favro API key')
    .option('--api-key <key>', 'API key to save (skip interactive prompt)')
    .action(async (options) => {
      let apiKey = options.apiKey as string | undefined;

      if (!apiKey) {
        console.log('Enter your Favro API key.');
        console.log('You can generate one at: https://favro.com/organization settings → API tokens\n');
        apiKey = await promptInput('API key: ', true);
      }

      if (!apiKey || apiKey.length === 0) {
        console.error('✗ No API key provided.');
        process.exit(1);
      }

      try {
        const existing = await readConfig();
        const updated = { ...existing, apiKey };
        await writeConfig(updated);
        console.log(`✓ API key saved to ${CONFIG_FILE}`);
      } catch (err: any) {
        console.error(`✗ ${err.message}`);
        process.exit(1);
      }
    });

  // ─── auth check ─────────────────────────────────────────────────────────────
  auth
    .command('check')
    .description('Verify your API key is valid')
    .option('--api-key <key>', 'API key to check (overrides config/env)')
    .action(async (options) => {
      // Resolve key: flag > env > config
      let apiKey = options.apiKey as string | undefined;

      if (!apiKey) {
        apiKey = process.env.FAVRO_API_KEY;
      }

      if (!apiKey) {
        try {
          const config = await readConfig();
          apiKey = config.apiKey;
        } catch (err: any) {
          console.error(`✗ ${err.message}`);
          process.exit(1);
        }
      }

      if (!apiKey) {
        console.error('✗ No API key configured. Run `favro auth login` to set one.');
        console.error('  Or set FAVRO_API_KEY environment variable.');
        process.exit(1);
      }

      console.log('Checking API key...');
      try {
        const valid = await validateApiKey(apiKey);
        if (valid) {
          console.log('✓ API key is valid');
        } else {
          console.error('✗ API key is invalid or unauthorized.');
          console.error('  Get a new key at: https://favro.com/ → Organization Settings → API tokens');
          process.exit(1);
        }
      } catch (err: any) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`✗ Could not verify API key: ${msg}`);
        process.exit(1);
      }
    });
}

export default registerAuthCommand;
