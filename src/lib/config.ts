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
  outputFormat?: 'table' | 'json' | 'csv';
  /** AI provider configuration for LLM-powered commands */
  ai?: {
    provider: 'anthropic' | 'openai' | 'ollama';
    model?: string;
    apiKey?: string;
    ollamaBaseUrl?: string;
  };
}

export const CONFIG_DIR = path.join(os.homedir(), '.favro');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Read config from ~/.favro/config.json.
 * Returns empty config if file doesn't exist.
 * Throws on permission errors or corrupted JSON.
 */
export async function readConfig(): Promise<FavroConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as FavroConfig;
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {};
    }
    // Fix: explicit SyntaxError check (SyntaxError has no .code property)
    if (err instanceof SyntaxError) {
      throw new Error(`Config file is corrupted (invalid JSON): ${CONFIG_FILE}\nFix or delete it: rm ${CONFIG_FILE}`);
    }
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(`Config file permission error: ${CONFIG_FILE} is not readable. Check file permissions.`);
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
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      throw new Error(`Config file permission error: cannot write to ${CONFIG_FILE}. Check directory permissions.`);
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
