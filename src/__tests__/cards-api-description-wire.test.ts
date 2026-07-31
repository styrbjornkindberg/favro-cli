/**
 * Wire-level tests for the card description write path — issue #17.
 *
 * Same discipline as the dependency (#12) and tag (#16) wire tests: no client
 * mock. A real `node:http` server stands in for Favro, so the axios stack builds
 * the URL and serialises the body, and the assertions are about what Favro
 * actually receives. A mock asserting the body shape is exactly what let this bug
 * live — the old code put `descriptionFormat` in the body, the mock test asserted
 * it there, and Favro ignored it.
 *
 * Expectations below are pinned to responses observed against the live Favro API
 * (probe recorded in #15/#17):
 *
 * - `PUT body descriptionFormat=markdown` → 200, body escaped as literal text with
 *                                           U+200B injected after every `[`, so
 *                                           `- [ ]` checkboxes are destroyed.
 * - `PUT ?descriptionFormat=markdown`     → 200, byte-clean round-trip.
 * - `PUT ?descriptionFormat=md|plaintext` → 200, new body *appended* after the old
 *                                           one with a `<br>` — refused client-side.
 * - `PUT {description: …}`                → 200, nothing written (silent no-op);
 *                                           the real field is `detailedDescription`.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';

interface Received {
  method: string;
  url: string;
  body: string;
}

const CARD = '713db3018af39956227d4279';
const BODY = '# Acceptance\n\n- [ ] one\n- [ ] two\n';

function startServer(): Promise<{
  api: CardsAPI;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cardId: CARD, name: 'probe', detailedDescription: BODY }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` });
      resolve({
        api: new CardsAPI(client as any),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function sent(received: Received[], method: string): Received {
  const hit = received.find((r) => r.method === method);
  if (!hit) throw new Error(`no ${method} was sent`);
  return hit;
}

describe('card description writes (no client mock)', () => {
  test('updateCard puts descriptionFormat on the query string, not in the body', async () => {
    const { api, received, close } = await startServer();
    try {
      await api.updateCard(CARD, { description: BODY });
      const put = sent(received, 'PUT');
      expect(put.url).toBe(`/api/v1/cards/${CARD}?descriptionFormat=markdown`);
      expect(JSON.parse(put.body)).toEqual({ detailedDescription: BODY });
    } finally {
      await close();
    }
  });

  test('createCard puts descriptionFormat on the query string, not in the body', async () => {
    const { api, received, close } = await startServer();
    try {
      await api.createCard({ name: 'probe', description: BODY, widgetCommonId: 'w1' });
      const post = sent(received, 'POST');
      expect(post.url).toBe('/api/v1/cards?descriptionFormat=markdown');
      expect(JSON.parse(post.body)).toEqual({
        name: 'probe',
        detailedDescription: BODY,
        widgetCommonId: 'w1',
      });
    } finally {
      await close();
    }
  });

  test('the markdown body reaches the wire byte-clean — no U+200B, no `- [ ]` damage', async () => {
    const { api, received, close } = await startServer();
    try {
      await api.updateCard(CARD, { description: BODY });
      const written = JSON.parse(sent(received, 'PUT').body).detailedDescription as string;
      expect(written).toBe(BODY);
      expect(written).not.toContain('​');
      expect(written).toContain('- [ ] one');
    } finally {
      await close();
    }
  });

  test('`description` never reaches the wire — Favro 200s on it and writes nothing', async () => {
    const { api, received, close } = await startServer();
    try {
      await api.updateCard(CARD, { description: BODY });
      expect(JSON.parse(sent(received, 'PUT').body)).not.toHaveProperty('description');
    } finally {
      await close();
    }
  });

  test('a descriptionFormat other than markdown is refused before it is sent', async () => {
    // Favro answers 200 and leaves the card holding the new body concatenated
    // after the old one — a loud client-side refusal beats that silent corruption.
    const { api, received, close } = await startServer();
    try {
      await expect(
        api.updateCard(CARD, { description: BODY, descriptionFormat: 'plaintext' } as any),
      ).rejects.toThrow(/Unsupported descriptionFormat "plaintext"/);
      expect(received).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
