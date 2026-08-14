/**
 * Auth Commands for Favro CLI
 * CLA-1773: Configuration & Auth Setup
 *
 * Commands:
 *   favro auth login   — prompts for API key, saves to config
 *   favro auth logout  — removes API key from config
 *   favro auth check   — validates API key against Favro API (alias for verify)
 *   favro auth verify  — validates API key against Favro API (spec-compliant name)
 *
 * ANONYMOUS, AND THAT IS THE POINT (ADR-0002, #118). These are the commands you
 * reach for when you have no credentials, so `{ anonymous: true }` drops
 * `ctx.client` from the type: `favro auth login` is provably credential-free
 * because the runner has nothing to build and the handler has nothing to touch.
 * The keys they DO use are the ones typed at the prompt, held locally.
 *
 * All four are on the `void` arm — the prompts and the ✓/✗ lines are the answer.
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import * as readline from 'readline';
import { readConfig, writeConfig, configFile } from '../lib/config';
import { getAllPages } from '../lib/paginate';
import { foldName } from '../lib/fold-name';
import { RefusalError } from '../lib/refusal';
// `AnonymousCtx` is spelled out even where the handler ignores it: the scope-lock
// detector reads the first parameter's TYPE to decide whether it can follow the
// writes inside, and a handler with no parameters at all is invisible to it.
import { AnonymousCtx, run } from '../lib/run';

/**
 * Prompt user for input interactively.
 * Exported for testing.
 *
 * FAIL CLOSED FIRST (#147). `readline` on a pipe never resolves — measured: this
 * function outlived a 5-second SIGKILL with stdin piped, which under `favro_run`
 * is the whole 60s budget spent for no answer. The list in
 * `lib/interactive-commands.ts` keeps `favro auth login` from being spawned at
 * all, but it lets the FLAGGED form through on purpose (`--email` + `--api-key`
 * is the only way an agent can authenticate), and that form still lands here:
 *
 *   - an account with more than one organization reaches the picker below
 *     (`Select organization [1-n]`), which no flag skips;
 *   - `--email ""` leaves the value falsy and the caller prompts for what it did
 *     not get. Measured before this guard: `favro_run` returned after 60022ms
 *     with a bare "Command failed".
 *
 * A list of command PATHS cannot see either case — it has no idea how many
 * organizations an account has. So the guard goes where all three call sites
 * route through, exactly as `confirmAction` (`lib/safety.ts`) already does for
 * the write confirmations.
 *
 * `!isTTY`, not `isTTY === false`: node leaves the property UNDEFINED on a pipe
 * rather than setting it false (measured), so the equality form does not fire
 * where it matters most.
 */
export async function promptInput(question: string, masked: boolean = false): Promise<string> {
  if (!process.stdin.isTTY) {
    // A `RefusalError`: no terminal is configuration, so the identical call
    // declines identically and `retryable: false` is the honest answer.
    throw new RefusalError(
      `Cannot prompt for "${question.trim()}" without a terminal.\n` +
      '  Run `favro auth login` directly in a terminal, or set FAVRO_API_KEY, ' +
      'FAVRO_EMAIL and FAVRO_ORGANIZATION_ID in the environment instead — ' +
      '`resolveAuth` reads all three without any prompt.',
    );
  }

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
 * Uses resolveAuth() for consistent priority across all commands.
 *
 * Every decline is a `RefusalError`: an absent key stays absent and an
 * unauthorized key stays unauthorized, so the retry declines identically and
 * `retryable: false` is the honest answer. A thrown `resolveAuth` — a
 * malformed config, an unreadable file — propagates as itself.
 */
async function runVerify(options: { apiKey?: string }): Promise<void> {
  const auth = await (await import('../lib/config')).resolveAuth({ apiKey: options.apiKey });

  if (!auth.token) {
    throw new RefusalError('API key not found. Run `favro auth login` first');
  }
  if (!auth.email) {
    throw new RefusalError('Email not configured. Run `favro auth login` first');
  }

  console.log('Checking API key...');
  if (!(await validateApiKey(auth.token, auth.email))) {
    throw new RefusalError(
      '✗ API key is invalid or unauthorized.\n' +
      '  Get a new key at: https://favro.com/ → Organization Settings → API tokens',
    );
  }
  console.log('✓ API key is valid');
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Authentication commands');

  // ─── auth login ─────────────────────────────────────────────────────────────
  auth
    .command('login')
    .description('Set up your Favro credentials (email + API key)')
    .option('--api-key <key>', 'API key to save (skip interactive prompt)')
    .option('--email <email>', 'Email address to save (skip interactive prompt)')
    .action(run({ anonymous: true }, async (_ctx, options: { apiKey?: string; email?: string }) => {
      let apiKey = options.apiKey;
      let email = options.email;

      console.log('Favro CLI — Authentication Setup');
      console.log('─'.repeat(40));

      if (!email) {
        console.log('Enter the email address associated with your Favro account.');
        email = await promptInput('Email: ', false);
      }
      if (!email || email.length === 0) {
        throw new RefusalError('No email provided.');
      }

      if (!apiKey) {
        console.log('\nEnter your Favro API token.');
        console.log('Generate one at: https://favro.com/ → Profile → API tokens\n');
        apiKey = await promptInput('API token: ', true);
      }
      if (!apiKey || apiKey.length === 0) {
        throw new RefusalError('No API key provided.');
      }

      // Validate credentials before saving.
      //
      // The `✗` marker closes the line this command left open with a bare
      // `process.stdout.write`, then the error goes to the runner's boundary —
      // which is the one place that decides the stream, the wording and the
      // exit code.
      process.stdout.write('\nValidating credentials...');
      const valid = await validateApiKey(apiKey, email).catch((err) => {
        process.stdout.write(' ✗\n');
        throw err;
      });
      if (!valid) {
        process.stdout.write(' ✗\n');
        throw new RefusalError('Invalid credentials. Check your email and API token and try again.');
      }
      process.stdout.write(' ✓\n');

      // Auto-discover organization ID
      let organizationId: string | undefined;
      process.stdout.write('Fetching organization...');
      const orgs = await new FavroHttpClient({ auth: { token: apiKey, email } })
        .get<{ entities: Array<{ organizationId: string; name: string }> }>('/organizations')
        .then((response) => response.entities ?? [])
        .catch((err) => {
          process.stdout.write(' ✗\n');
          throw err;
        });

      if (orgs.length === 0) {
        process.stdout.write(' ⚠\n');
        console.warn('⚠  No organizations found for this account. You can set FAVRO_ORGANIZATION_ID manually.');
      } else if (orgs.length === 1) {
        organizationId = orgs[0].organizationId;
        process.stdout.write(` ✓ (${orgs[0].name})\n`);
      } else {
        process.stdout.write('\n');
        console.log('\nMultiple organizations found:');
        orgs.forEach((org, i) => console.log(`  ${i + 1}. ${org.name} (${org.organizationId})`));
        const pick = await promptInput(`\nSelect organization [1-${orgs.length}]: `, false);
        const idx = parseInt(pick, 10) - 1;
        if (!(idx >= 0 && idx < orgs.length)) {
          throw new RefusalError(`"${pick}" is not one of the ${orgs.length} organizations offered.`);
        }
        organizationId = orgs[idx].organizationId;
        console.log(`✓ Using: ${orgs[idx].name}`);
      }

      // Save everything to config
      const existing = await readConfig();
      const updated = { ...existing, apiKey, email, ...(organizationId ? { organizationId } : {}) };

      // Resolve userId by matching email against /users endpoint
      if (organizationId) {
        try {
          process.stdout.write('Resolving user identity...');
          const userClient = new FavroHttpClient({
            auth: { token: apiKey, email, organizationId },
          });
          // `getAllPages`, not a bare `/users` — that read one page of a
          // two-page organization and left this printing "not found in org
          // users" for the caller's own account (#162 item 7), which made the
          // remedy every `@me` refusal names not work either. The pager
          // directly rather than `UsersAPI.listUsers` (which is this same call):
          // `login` has no `ctx.api` to reach for — it builds a client from
          // credentials that are not saved yet — and `new …API(` is banned in
          // `src/commands/` by the runner ratchet.
          const users = await getAllPages<{ userId: string; email: string; name: string }>(
            userClient, '/users');
          // `foldName`, the same fold `config.ts`'s `resolveUserId` uses on
          // this exact comparison: the address was typed at the prompt above
          // and the wire's was not, so an accented local part reaches the two
          // sides in different normalisation forms (#141).
          const me = users.find((u: { email: string }) => foldName(u.email) === foldName(email));
          if (me) {
            updated.userId = me.userId;
            process.stdout.write(` ✓ (${me.name})\n`);
          } else {
            process.stdout.write(' ⚠ (not found in org users)\n');
          }
        } catch {
          process.stdout.write(' ⚠ (skipped)\n');
        }
      }

      await writeConfig(updated);
      console.log(`\n✓ Credentials saved to ${configFile()}`);
      if (!organizationId) {
        console.log('  ⚠  Organization ID not saved. Set FAVRO_ORGANIZATION_ID or re-run `favro auth login`.');
      }
    }));

  // ─── auth logout ────────────────────────────────────────────────────────────
  // Fix (Issue 4): implement logout command as required by spec
  auth
    .command('logout')
    .description('Remove saved API key from config')
    .action(run({ anonymous: true }, async (_ctx: AnonymousCtx) => {
      const existing = await readConfig();
      if (!existing.apiKey) {
        console.log('ℹ No API key stored in config.');
        return;
      }
      const { apiKey: _removed, ...rest } = existing;
      await writeConfig(rest);
      console.log(`✓ API key removed from ${configFile()}`);
    }));

  // ─── auth verify ─────────────────────────────────────────────────────────────
  // Fix (Issue 4): add `auth verify` as spec-compliant command name
  auth
    .command('verify')
    .description('Verify your API key is valid (spec-compliant name)')
    .option('--api-key <key>', 'API key to check (overrides config/env)')
    .action(run({ anonymous: true }, (_ctx, options: { apiKey?: string }) => runVerify(options)));

  // ─── auth check ─────────────────────────────────────────────────────────────
  // Fix (Issue 3): use resolveApiKey() via shared runVerify() for consistent priority
  auth
    .command('check')
    .description('Verify your API key is valid')
    .option('--api-key <key>', 'API key to check (overrides config/env)')
    .action(run({ anonymous: true }, (_ctx, options: { apiKey?: string }) => runVerify(options)));
}

export default registerAuthCommand;
