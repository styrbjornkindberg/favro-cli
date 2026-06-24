/**
 * Unit tests for src/mcp-http-server.ts
 *
 * The Favro HTTP client is mocked so org resolution never hits the network.
 * createMcpServer / the streamable transport are not exercised here — these
 * tests cover auth parsing and organization resolution, the HTTP-specific
 * logic. Tool dispatch is covered by mcp-server.test.ts.
 */

import { IncomingMessage, ServerResponse } from 'http';

jest.mock('../lib/http-client');

import FavroHttpClient from '../lib/http-client';
import { resolveOrg, handleMcpRequest } from '../mcp-http-server';

const MockClient = FavroHttpClient as unknown as jest.Mock;

/** Configure the mocked client's get() for the next construction. */
function mockOrganizations(entities: Array<{ organizationId: string; name: string }>) {
  MockClient.mockImplementation(() => ({
    get: jest.fn().mockResolvedValue({ entities }),
  }));
}

function mockOrganizationsError(status?: number) {
  MockClient.mockImplementation(() => ({
    get: jest.fn().mockRejectedValue(status ? { response: { status } } : new Error('network')),
  }));
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  writeHead: (status: number, headers?: Record<string, string>) => FakeRes;
  end: (body?: string) => void;
  on: jest.Mock;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      this.headersSent = true;
      return this;
    },
    end(body) {
      if (body) this.body = body;
    },
    on: jest.fn(),
  };
  return res;
}

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers, method: 'POST', url: '/mcp', on: jest.fn() } as unknown as IncomingMessage;
}

function basic(email: string, token: string): string {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Basic-auth parsing (via handleMcpRequest) ───────────────────────────────

describe('Basic auth parsing', () => {
  test('401 when Authorization header missing', async () => {
    const res = fakeRes();
    await handleMcpRequest(fakeReq({}), res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toContain('Basic');
    expect(res.body).toContain('"jsonrpc"');
  });

  test('401 when credentials have no colon', async () => {
    const res = fakeRes();
    const header = 'Basic ' + Buffer.from('nocolon').toString('base64');
    await handleMcpRequest(fakeReq({ authorization: header }), res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
  });

  test('401 when email or token empty', async () => {
    const res = fakeRes();
    await handleMcpRequest(fakeReq({ authorization: basic('', 'tok') }), res as unknown as ServerResponse);

    expect(res.statusCode).toBe(401);
  });
});

// ─── Organization resolution ─────────────────────────────────────────────────

describe('resolveOrg', () => {
  test('header override wins without calling Favro', async () => {
    const result = await resolveOrg({ email: 'h@x.com', token: 't' }, 'orgHeader');

    expect(result).toEqual({ orgId: 'orgHeader' });
    expect(MockClient).not.toHaveBeenCalled();
  });

  test('single org is resolved and used', async () => {
    mockOrganizations([{ organizationId: 'orgSolo', name: 'Solo' }]);

    const result = await resolveOrg({ email: 'single@x.com', token: 't' }, undefined);

    expect(result).toEqual({ orgId: 'orgSolo' });
    expect(MockClient).toHaveBeenCalledTimes(1);
  });

  test('second call with same creds hits cache (no second fetch)', async () => {
    mockOrganizations([{ organizationId: 'orgCache', name: 'Cached' }]);

    await resolveOrg({ email: 'cache@x.com', token: 't' }, undefined);
    const second = await resolveOrg({ email: 'cache@x.com', token: 't' }, undefined);

    expect(second).toEqual({ orgId: 'orgCache' });
    expect(MockClient).toHaveBeenCalledTimes(1);
  });

  test('multiple orgs without header → 400 listing ids', async () => {
    mockOrganizations([
      { organizationId: 'org1', name: 'One' },
      { organizationId: 'org2', name: 'Two' },
    ]);

    const result = await resolveOrg({ email: 'multi@x.com', token: 't' }, undefined);

    expect(result).toEqual({ error: { status: 400, message: expect.stringContaining('org1') } });
    expect((result as { error: { message: string } }).error.message).toContain('org2');
  });

  test('zero orgs → 400', async () => {
    mockOrganizations([]);

    const result = await resolveOrg({ email: 'none@x.com', token: 't' }, undefined);

    expect(result).toEqual({ error: { status: 400, message: expect.stringContaining('No organizations') } });
  });

  test('401 from Favro → invalid credentials error', async () => {
    mockOrganizationsError(401);

    const result = await resolveOrg({ email: 'bad@x.com', token: 't' }, undefined);

    expect(result).toEqual({ error: { status: 401, message: expect.stringContaining('Invalid') } });
  });

  test('network failure → 502', async () => {
    mockOrganizationsError();

    const result = await resolveOrg({ email: 'down@x.com', token: 't' }, undefined);

    expect(result).toEqual({ error: { status: 502, message: expect.stringContaining('Failed') } });
  });
});
