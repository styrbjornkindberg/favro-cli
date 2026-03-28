/**
 * Client Factory — centralises auth resolution + FavroHttpClient construction.
 *
 * Every command should use `createFavroClient()` instead of manually calling
 * `resolveApiKey()` + `new FavroHttpClient(...)`.
 */
import FavroHttpClient from './http-client';
import { resolveAuth } from './config';
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
  const auth = await resolveAuth(flags);

  if (!auth.token) {
    console.error(`Error: ${missingApiKeyError()}`);
    process.exit(1);
  }

  if (!auth.email) {
    console.error(
      'Error: Email address not configured.\n' +
      '  Run `favro auth login` to set up your credentials.\n' +
      '  Or set the FAVRO_EMAIL environment variable.'
    );
    process.exit(1);
  }

  return new FavroHttpClient({ auth });
}

export default createFavroClient;
