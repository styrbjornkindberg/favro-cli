/**
 * `retryable` at the error boundary, over a real socket (#134).
 *
 * The boundary and the dispatch table classify DIFFERENT populations of errors
 * (ADR-0002, "Two populations"). #134 made the boundary default to
 * `retryable: false` for anything it cannot place as a wire failure — which is
 * only safe if a genuine wire failure still comes back `true`. That is what
 * this file holds down.
 *
 * A real `node:http` server, not a queued mock: a mock handing back a canned
 * `{status: 429}` object proves the classifier reads a field we wrote
 * ourselves. What has to be true is that an error axios raises from an ACTUAL
 * 429 response — after `http-client`'s retry loop has given up on it — still
 * reads as retryable. Only a socket produces that error.
 *
 * The three statuses are served on three paths of ONE server and driven
 * concurrently: 429 and 503 are both retried four times with 1s/2s/4s/8s
 * backoff, so running them in parallel costs 15s once rather than twice.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import { run } from '../lib/run';

let server: http.Server;
let client: FavroHttpClient;
let tmpConfigDir: string;
let out: jest.SpyInstance;
let errStream: jest.SpyInstance;

/** `/429`, `/503`, `/403` — the status is the path. */
beforeAll(async () => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-boundary-wire-'));
  server = http.createServer((req, res) => {
    const status = Number((req.url ?? '/500').slice(1).split('?')[0]);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'from the wire' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  client = new FavroHttpClient({
    baseURL: `http://127.0.0.1:${port}`,
    auth: { token: 'k', email: 'a@b.c', organizationId: 'org-1' },
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.FAVRO_CONFIG_DIR = tmpConfigDir;
  process.exitCode = undefined;
  out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  // `http-client` announces each rate-limit backoff on stderr.
  errStream = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env.FAVRO_CONFIG_DIR;
});

/**
 * Drive one GET through the runner's boundary and read back the envelope it
 * put on stdout. Anonymous so the runner builds no client of its own — the one
 * pointed at the stand-in is the only client in play.
 */
async function envelopeFor(status: number): Promise<{ message: string; retryable: boolean }> {
  const root = new Command();
  root.exitOverride();
  const leaf = root.command(`s${status}`).exitOverride();
  leaf.action(
    run({ anonymous: true }, async () => {
      await client.get(`/${status}`);
    }),
  );
  await root.parseAsync([`s${status}`], { from: 'user' });
  // Matched by status, not by position: the three runs share one `console.log`
  // spy and finish out of order, so "the first error line" is whichever request
  // came back first — the 403, which is never retried.
  const written = out.mock.calls.map((call) => String(call[0]));
  const line = written.find((l) => l.includes('"error"') && l.includes(String(status)));
  if (!line) throw new Error(`no ${status} envelope on stdout; saw ${JSON.stringify(written)}`);
  return JSON.parse(line).error;
}

describe('the error boundary over a real socket', () => {
  it('still says retry a 429 and a 503, and says do not retry a 403', async () => {
    // Concurrent on purpose: both retried statuses serve their backoff at once.
    const [rateLimited, unavailable, forbidden] = await Promise.all([
      envelopeFor(429),
      envelopeFor(503),
      envelopeFor(403),
    ]);

    // The transient family. `http-client` already retried each four times, and
    // the advice an agent reads must still be "this one may behave differently".
    expect(rateLimited.retryable).toBe(true);
    expect(unavailable.retryable).toBe(true);
    // A 403 is a permission denial by default (`favro-error.ts`, fail-closed) —
    // deterministic, so retrying it is the loop #51 closed.
    expect(forbidden.retryable).toBe(false);
    expect(errStream).toHaveBeenCalled();
  }, 40000);
});
