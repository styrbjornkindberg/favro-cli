/**
 * Config Management for Favro CLI
 * CLA-1773: Configuration & Auth Setup
 *
 * Config file: ~/.favro/config.json
 * Priority: --api-key flag > FAVRO_API_KEY env > config file
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { foldName } from './fold-name';

export interface FavroConfig {
  apiKey?: string;
  /** Email address used for Basic Auth */
  email?: string;
  /** Favro organization ID — sent as `organizationId` header on all org-level requests */
  organizationId?: string;
  defaultBoard?: string;
  defaultCollection?: string;
  /** Guardrail lock: write commands restricted to this collection unless --force is used */
  scopeCollectionId?: string;
  /** Cached human-readable name of the locked collection */
  scopeCollectionName?: string;
  /** Cached Favro userId — resolved during `auth login` by matching email against /users */
  userId?: string;
  /**
   * Tracker mapping — the repo-less fallback only. The authoritative store is
   * the git-committed `docs/agents/issue-tracker.md`; see `tracker-config.ts`.
   */
  tracker?: {
    collectionId: string;
    boardId: string;
    columns: { active: string; done: string };
  };
  outputFormat?: 'table' | 'json' | 'csv';
}

/**
 * Config directory. Defaults to ~/.favro, but can be overridden via
 * FAVRO_CONFIG_DIR. The HTTP MCP server uses this to give each user their own
 * isolated config (scope, cached userId, defaults) on a shared server, since
 * every CLI invocation is a fresh process whose env is set before it starts.
 *
 * Resolved per call, not at import: a frozen constant made FAVRO_CONFIG_DIR
 * unsettable from a test that had already imported this module (issue #65).
 */
export function configDir(): string {
  return process.env.FAVRO_CONFIG_DIR || path.join(os.homedir(), '.favro');
}

export function configFile(): string {
  return path.join(configDir(), 'config.json');
}

/**
 * The per-session scope lock override, or `undefined` when the var is unset (#174).
 *
 * The lock lives in one file and every reader loads it fresh per invocation, so
 * two shells — two terminals, or two agents driving the CLI in parallel — could
 * not hold different locks: `favro scope set X` in one silently retargeted the
 * other's next write. An env var IS session state (per-shell, inherited by
 * children, dies with the window), so this is the whole of the fix; there is no
 * session id, lockfile, registry or TTL. It also joins the lock to the priority
 * order every other field already uses — flag > `FAVRO_*` env > config file.
 *
 * FAIL-CLOSED on empty or whitespace-only, and that is the point rather than
 * tidiness: falling through to the file value would make a typo silently mean
 * something else, and resolving to "no lock" would silently unlock every board
 * in the organization. A bare `Error`, mirroring `resolveApiKey`'s empty
 * `FAVRO_API_KEY` throw below — a malformed environment is not a refusal, and
 * `withClient`'s dry-run deferral only swallows `RefusalError`, so this stays
 * loud on the preview path too.
 */
export function scopeOverride(): string | undefined {
  const raw = process.env.FAVRO_SCOPE_COLLECTION_ID;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(
      'FAVRO_SCOPE_COLLECTION_ID is set but empty. Unset it or provide a collectionId.\n' +
        '  Unset it first: every command refuses while it is empty, `favro scope show` included.',
    );
  }
  return trimmed;
}

/**
 * The two remedies for a lock that came from the environment (#175), stated
 * once. `commands/scope.ts` prints them from `refuseIfOverridden` and the guards
 * in `safety.ts` print them through the two helpers below, so there is ONE
 * wording per instruction rather than one per site. Trailing punctuation is the
 * caller's, since each site continues the sentence differently.
 */
export const RETARGET_SHELL = 'To retarget this shell: export FAVRO_SCOPE_COLLECTION_ID=<collectionId>';
export const UNLOCK_SHELL = 'To unlock this shell: unset FAVRO_SCOPE_COLLECTION_ID';

/**
 * The remediation line a scope refusal ends with, aware of WHERE THE LOCK CAME
 * FROM (#175).
 *
 * `Run 'favro scope set …'` is wrong advice under `FAVRO_SCOPE_COLLECTION_ID`:
 * `scope set` refuses while the override is live (#174, by design), so following
 * the guardrail's own advice produced a second refusal. The source is known here
 * and nowhere else — the same reason #174 put the merge in `readConfig` rather
 * than in each reader — so the guards ask for a line instead of reading the
 * variable a second time.
 *
 * `scopeRemedy` is the retarget-or-force flavour (board and collection guards);
 * `scopeUnlockRemedy` the unlock-or-force one (`assertOrgScope`, whose write
 * cannot be narrowed to any lock). Both file arms are byte-identical to what
 * shipped — two ratchets pin them.
 *
 * The unlock arm names TWO steps, and that is not padding. `UNLOCK_SHELL` alone
 * is the right whole answer for `scope clear`'s own refusal — unset the variable
 * and the command works — but it is NOT the whole answer for an org-wide write:
 * unsetting only drops the session lock, and the config file's lock then applies
 * and refuses the same write again. Measured on `dist/cli.js`: file lock
 * `coll-file`, `FAVRO_SCOPE_COLLECTION_ID=coll-env`, `tags delete tag-1` refused;
 * unset the variable and it refused a second time. One sentence per instruction
 * still holds — the two sites share `UNLOCK_SHELL`, and only this one continues
 * it.
 */
export function scopeRemedy(): string {
  return scopeOverride() === undefined
    ? `Run 'favro scope set <collectionId>' to change it, or pass --force to override.`
    : `${RETARGET_SHELL}, or pass --force to override.`;
}

export function scopeUnlockRemedy(): string {
  return scopeOverride() === undefined
    ? `Run 'favro scope clear' to unlock, or pass --force to allow this single write.`
    : `${UNLOCK_SHELL} — then 'favro scope clear' if the\n` +
      `  config file still locks you. Or pass --force to allow this single write.`;
}

/**
 * Read config from ~/.favro/config.json, with the `FAVRO_SCOPE_COLLECTION_ID`
 * override applied. Returns empty config if file doesn't exist. Throws on
 * permission errors, corrupted JSON, or an empty override.
 *
 * The merge is HERE and not in `loadConfig` (#174): `loadConfig` looks like the
 * merge point and is dead outside tests — every real reader, including all 26
 * guarded command registrations, calls `readConfig` directly, so an override
 * merged there is one no scope guard would ever see.
 *
 * `scopeCollectionName` is unknown on the env path, so refusals print the raw
 * id. Every consumer already handles that: `config.scopeCollectionName ??
 * config.scopeCollectionId`.
 */
export async function readConfig(): Promise<FavroConfig> {
  const fileConfig = await readConfigFile();
  const envScope = scopeOverride();
  if (envScope === undefined) return fileConfig;
  return { ...fileConfig, scopeCollectionId: envScope, scopeCollectionName: undefined };
}

/** Just the two lock fields, so spreading them restores absence as absence. */
function scopeFieldsOnDisk(
  file: FavroConfig,
): Pick<FavroConfig, 'scopeCollectionId' | 'scopeCollectionName'> {
  return { scopeCollectionId: file.scopeCollectionId, scopeCollectionName: file.scopeCollectionName };
}

/** The file's contents, before any env override — what `writeConfig` must preserve. */
async function readConfigFile(): Promise<FavroConfig> {
  try {
    const raw = await fs.readFile(configFile(), 'utf-8');
    return JSON.parse(raw) as FavroConfig;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {};
    }
    // Fix: explicit SyntaxError check (SyntaxError has no .code property)
    if (err instanceof SyntaxError) {
      throw new Error(`Config file is corrupted (invalid JSON): ${configFile()}\nFix or delete it: rm ${configFile()}`);
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(`Config file permission error: ${configFile()} is not readable. Check file permissions.`);
    }
    throw new Error(`Failed to read config: ${err.message}`);
  }
}

/**
 * Write config to ~/.favro/config.json.
 * Creates ~/.favro directory if it doesn't exist.
 *
 * THE SESSION LOCK MUST NOT REACH DISK (#174). Six call sites feed this a
 * `readConfig()`-derived object — `resolveUserId` below, `tracker-init`,
 * `scope set`/`scope clear`, `auth login` and `auth logout` — so a naive merge in
 * `readConfig` would let the next `auth login`, or any `resolveUserId`
 * auto-resolve (which fires on `next`, `my-cards`, `my-standup` and `@me`),
 * persist the session lock as the GLOBAL one: exactly the bug #174 closes,
 * arriving later and harder to see.
 *
 * One guard in the shared writer rather than six at the callers — a smaller diff,
 * and it covers callers added later. `JSON.stringify` drops `undefined` values,
 * so restoring an absent file field removes the key rather than blanking it.
 */
export async function writeConfig(config: FavroConfig): Promise<void> {
  // Outside the try on purpose: the read's own message ("not readable") must not
  // be re-wrapped as the write's ("cannot write to").
  const onDisk = scopeOverride() === undefined
    ? config
    : { ...config, ...scopeFieldsOnDisk(await readConfigFile()) };
  try {
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(configFile(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(`Config file permission error: cannot write to ${configFile()}. Check directory permissions.`);
    }
    throw new Error(`Failed to write config: ${err.message}`);
  }
}

/**
 * Resolve API key with correct priority:
 * 1. flagApiKey (--api-key flag)
 * 2. FAVRO_API_KEY env var
 * 3. config file apiKey
 * 4. FAVRO_API_TOKEN env var (legacy support)
 */
export async function resolveApiKey(flagApiKey?: string): Promise<string | undefined> {
  if (flagApiKey) return flagApiKey;
  // Fix: Detect empty string FAVRO_API_KEY and warn instead of silently falling through
  const envKey = process.env.FAVRO_API_KEY;
  if (envKey !== undefined && envKey.length === 0) {
    throw new Error('FAVRO_API_KEY is set but empty. Unset it or provide a valid key.\n  Run `favro auth login` to configure a key.');
  }
  if (envKey) return envKey;
  const config = await readConfig();
  if (config.apiKey) return config.apiKey;
  if (process.env.FAVRO_API_TOKEN) return process.env.FAVRO_API_TOKEN;
  return undefined;
}

/**
 * Resolve full auth credentials needed for the Favro API:
 *   - token (API key)
 *   - email (for Basic Auth)
 *   - organizationId (sent as header on all org-level requests)
 *
 * Priority order for each field:
 *   flag override > FAVRO_* env var > ~/.favro/config.json
 */
export async function resolveAuth(flags?: {
  apiKey?: string;
  email?: string;
  organizationId?: string;
}): Promise<{ token: string | undefined; email: string | undefined; organizationId: string | undefined }> {
  const token = await resolveApiKey(flags?.apiKey);
  const config = await readConfig();
  const email = flags?.email ?? process.env.FAVRO_EMAIL ?? config.email;
  const organizationId = flags?.organizationId ?? process.env.FAVRO_ORGANIZATION_ID ?? config.organizationId;
  return { token, email, organizationId };
}

/**
 * Load full config merged with env/flag overrides.
 * Returns a FavroConfig with all fields resolved.
 */
export async function loadConfig(overrides: Partial<FavroConfig> = {}): Promise<FavroConfig> {
  const fileConfig = await readConfig();
  const envApiKey = process.env.FAVRO_API_KEY;

  return {
    ...fileConfig,
    ...(envApiKey ? { apiKey: envApiKey } : {}),
    ...overrides,
  };
}

/**
 * Resolve the current user's Favro userId.
 * Returns cached userId from config. If not cached, auto-resolves by
 * fetching /users, matching by email, and persisting to config.
 *
 * `listUsers`, not one hand-rolled page (#162 item 7). `/users` answered
 * `{page: 0, pages: 2, limit: 100}` for a 135-user organization — measured
 * 2026-08-14 — and the caller's own account sat at index 112, so the match
 * failed for anyone past the first page, and every caller below refuses on a
 * falsy answer: `@me` (`assignee.ts`), `next`, `my-cards`, `my-standup` and the
 * interactive menu. `getAllPages` is what every other user read goes through.
 */
export async function resolveUserId(): Promise<string | undefined> {
  const config = await readConfig();
  if (config.userId) return config.userId;

  // Auto-resolve: need email + auth to call /users
  const auth = await resolveAuth({});
  if (!auth.token || !auth.email || !auth.organizationId) return undefined;

  try {
    const FavroHttpClient = (await import('./http-client')).default;
    const UsersAPI = (await import('./users-api')).default;
    const client = new FavroHttpClient({ auth: { token: auth.token, email: auth.email, organizationId: auth.organizationId } });
    const users = await new UsersAPI(client).listUsers();
    // `foldName`: the configured address was typed, the wire's was not, and an
    // accented local part can reach the two in different forms (#141).
    const me = users.find(u => foldName(u.email) === foldName(auth.email));
    if (me) {
      await writeConfig({ ...config, userId: me.userId });
      return me.userId;
    }
  } catch {
    // Silent failure — userId is optional
  }
  return undefined;
}
