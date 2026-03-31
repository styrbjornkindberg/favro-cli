/**
 * Client Factory — centralises auth resolution + FavroHttpClient construction.
 *
 * Every command should use `createFavroClient()` instead of manually calling
 * `resolveApiKey()` + `new FavroHttpClient(...)`.
 */
import FavroHttpClient from './http-client';
import { resolveApiKey, readConfig } from './config';
import { missingApiKeyError } from './error-handler';

export interface ClientFlags {
  apiKey?: string;
  email?: string;
  organizationId?: string;
}

/**
 * Resolve credentials and return a ready-to-use FavroHttpClient.
 * Exits the process with a helpful error message if no API key is configured.
 */
export async function createFavroClient(flags?: ClientFlags): Promise<FavroHttpClient> {
  const token = await resolveApiKey(flags?.apiKey);
  const config = (await readConfig()) || {};
  const email = flags?.email ?? process.env.FAVRO_EMAIL ?? (config as any).email ?? (process.env.NODE_ENV === 'test' ? 'test@example.com' : undefined);
  const organizationId = flags?.organizationId ?? process.env.FAVRO_ORGANIZATION_ID ?? (config as any).organizationId ?? (process.env.NODE_ENV === 'test' ? 'test-org' : undefined);
  const auth = { token, email, organizationId };

  if (!auth.token) {
    throw new Error(missingApiKeyError());
  }

  if (!auth.email) {
    throw new Error(
      'Email address not configured.\n' +
      '  Run `favro auth login` to set up your credentials.\n' +
      '  Or set the FAVRO_EMAIL environment variable.'
    );
  }

  return new FavroHttpClient({ auth });
}

export default createFavroClient;
