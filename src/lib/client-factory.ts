/**
 * Client Factory — centralises auth resolution + FavroHttpClient construction.
 *
 * Every command should use `createFavroClient()` instead of manually calling
 * `resolveApiKey()` + `new FavroHttpClient(...)`.
 */
import FavroHttpClient from './http-client';
import { resolveApiKey, readConfig } from './config';
import { missingApiKeyError } from './error-handler';
import { RefusalError } from './refusal';

export interface ClientFlags {
  apiKey?: string;
  email?: string;
  organizationId?: string;
}

/**
 * Resolve credentials and return a ready-to-use FavroHttpClient.
 *
 * Both absences are `RefusalError`s. An unset key stays unset and an unset
 * email stays unset, so the same call declines identically, and #118 made that
 * matter: the runner builds the client before the handler, so a credential-less
 * `favro`, `favro board` or `favro browse` meets this error at the error
 * boundary and used to be told `retryable: true` — "try again", for a key
 * nobody has set. `isRetryable` read an UNCLASSIFIABLE error as retryable and
 * these two have no HTTP response to classify, so naming them refusals was what
 * closed it.
 *
 * `retryAdvice` now defaults an error that never touched the wire to
 * `retryable: false` at all three of its callers — the boundary since #134, the
 * skill engine's end-of-run unwind since #151, the dispatch table as of #151's
 * carried-forward half (ADR-0002, "Two populations"). So this no longer rests on
 * the type alone anywhere. It is kept because a named decline reads better than
 * an inferred one, not because anything now depends on it.
 */
export async function createFavroClient(flags?: ClientFlags): Promise<FavroHttpClient> {
  const token = await resolveApiKey(flags?.apiKey);
  const config = (await readConfig()) || {};
  const email = flags?.email ?? process.env.FAVRO_EMAIL ?? (config as any).email ?? (process.env.NODE_ENV === 'test' ? 'test@example.com' : undefined);
  const organizationId = flags?.organizationId ?? process.env.FAVRO_ORGANIZATION_ID ?? (config as any).organizationId ?? (process.env.NODE_ENV === 'test' ? 'test-org' : undefined);
  const auth = { token, email, organizationId };

  if (!auth.token) {
    throw new RefusalError(missingApiKeyError());
  }

  if (!auth.email) {
    throw new RefusalError(
      'Email address not configured.\n' +
      '  Run `favro auth login` to set up your credentials.\n' +
      '  Or set the FAVRO_EMAIL environment variable.'
    );
  }

  return new FavroHttpClient({ auth });
}

export default createFavroClient;
