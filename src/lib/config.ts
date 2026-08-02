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
 * Read config from ~/.favro/config.json.
 * Returns empty config if file doesn't exist.
 * Throws on permission errors or corrupted JSON.
 */
export async function readConfig(): Promise<FavroConfig> {
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
 */
export async function writeConfig(config: FavroConfig): Promise<void> {
  try {
    await fs.mkdir(configDir(), { recursive: true });
    await fs.writeFile(configFile(), JSON.stringify(config, null, 2), { mode: 0o600 });
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
 */
export async function resolveUserId(): Promise<string | undefined> {
  const config = await readConfig();
  if (config.userId) return config.userId;

  // Auto-resolve: need email + auth to call /users
  const auth = await resolveAuth({});
  if (!auth.token || !auth.email || !auth.organizationId) return undefined;

  try {
    const FavroHttpClient = (await import('./http-client')).default;
    const client = new FavroHttpClient({ auth: { token: auth.token, email: auth.email, organizationId: auth.organizationId } });
    const resp = await client.get<{ entities?: Array<{ userId: string; email: string }> }>('/users', { params: { limit: 100 } });
    const users = resp.entities ?? [];
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
