/**
 * The drift test for client-side resolution refusals (#81).
 *
 * `refusal.ts` states the contract plainly: the dispatch table tests
 * `error instanceof RefusalError` and NOTHING else. A resolver that raises a
 * bare `Error` is therefore reported to an agent as `retryable: true` — advice
 * to repeat a call that will refuse identically, forever. Three resolvers did
 * exactly that (`ColumnResolutionError`, `TagLookupError`, `UserLookupError`),
 * and nothing but a test stops the fourth from being written the same way.
 *
 * Two arms, both read against the live thing, in the shape #74 established for
 * the help topic. The first reads the SOURCE for every resolution error class
 * declared in `src/lib`; the second DRIVES each resolver at a value nothing
 * matches and looks at what comes back. Neither asserts wording.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { RefusalError } from '../lib/refusal';
import { resolveNameToId, NameResolutionError, NamedRef } from '../lib/name-resolve';
import ColumnDirectory from '../lib/column-directory';
import { TagsAPI } from '../lib/tags-api';
import { UsersAPI } from '../lib/users-api';
import { resolveAssignee } from '../lib/assignee';
import CardReferenceResolver from '../lib/card-reference';
import { createFavroClient } from '../lib/client-factory';
import { loadSkill, getSkillPath } from '../lib/skill-store';

const LIB_DIR = path.resolve(__dirname, '..', 'lib');

// ─── arm one: every declared resolution error ────────────────────────────────

/**
 * A resolution error names itself: `<Thing>ResolutionError` or
 * `<Thing>LookupError`. Discovered rather than listed, so a resolver added
 * tomorrow is covered with nothing to remember — which is the whole point of a
 * drift test.
 */
const DECLARATION = /export class (\w+(?:Resolution|Lookup)Error)\b/g;

/**
 * The refusals that would otherwise escape the regex above, because they are
 * named irregularly. `refusal.ts` names them, so a regression in one is exactly
 * what this file exists to catch — and discovery alone would not have looked at
 * any of them.
 *
 * `ScopeError` is the odd one out and belongs here anyway (#120). It is not a
 * RESOLUTION refusal — nothing was being looked up — so #81's sweep correctly
 * passed over it and this file had no reason to find it. But it IS a refusal by
 * the definition that matters: `isRetryable` tests `instanceof RefusalError`
 * and nothing else, and while `ScopeError` extended bare `Error` a scope
 * violation came back `retryable: true`. The contract this file guards is about
 * that one `instanceof`, not about the word "resolution", so the scope lock is
 * in scope.
 *
 * Listed because they are named irregularly, not because listing is preferred:
 * anything matching the convention is still found without an edit here.
 */
const NAMED_IRREGULARLY: Array<[string, string]> = [
  ['assignee.ts', 'AssigneeError'],
  ['card-reference.ts', 'CardResolutionError'],
  ['tracker-config.ts', 'TrackerConfigError'],
  ['dispatch.ts', 'ReverseEdgeError'],
  ['safety.ts', 'ScopeError'],
];

function declaredErrors(): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const file of fs.readdirSync(LIB_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(LIB_DIR, file), 'utf-8');
    for (const match of source.matchAll(DECLARATION)) found.push([file, match[1]]);
  }
  for (const entry of NAMED_IRREGULARLY) {
    if (!found.some(([, name]) => name === entry[1])) found.push(entry);
  }
  return found;
}

describe('every resolution error in src/lib — and the scope lock — is a RefusalError', () => {
  const declared = declaredErrors();

  it('there are resolution errors to check at all', () => {
    // A regex that stopped matching would otherwise make `it.each` vacuous and
    // this file pass forever while checking nothing.
    expect(declared.length).toBeGreaterThanOrEqual(4);
  });

  it.each(declared)('%s declares %s', (file, name) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require(path.join(LIB_DIR, file));
    const cls = module[name];
    expect(typeof cls).toBe('function');
    expect(cls.prototype instanceof RefusalError).toBe(true);
  });
});

// ─── arm two: every resolver, driven ─────────────────────────────────────────

/** A client that reaches nothing: every listing comes back empty. */
const emptyClient = {
  organizationId: undefined,
  get: async () => ({ entities: [] }),
} as any;

const nameOptions = (label: string, kind: 'boards' | 'collections') => ({
  kind,
  fetch: async (): Promise<NamedRef[]> => [],
  value: 'Nothing Named This',
  label,
  listCommand: `favro ${kind} list`,
  useIdWith: `favro ${kind} get <id>`,
});

const resolvers: Array<[string, () => Promise<unknown>]> = [
  ['name-resolve (board)', () => resolveNameToId(nameOptions('board', 'boards'))],
  ['name-resolve (collection)', () => resolveNameToId(nameOptions('collection', 'collections'))],
  ['column-directory', () => new ColumnDirectory(emptyClient).resolveColumnId('Dong', 'board-a')],
  ['tags-api', () => new TagsAPI(emptyClient).getTag('no-such-tag')],
  ['users-api', () => new UsersAPI(emptyClient).getUser('Nobody Here')],
  ['assignee', () => resolveAssignee(emptyClient, 'Nobody Here')],
  ['card-reference', () => new CardReferenceResolver(emptyClient).toCardId('CLA-999999')],
];

describe('every module that resolves an identifier refuses with a RefusalError', () => {
  const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
  let tmpDir: string;

  beforeEach(() => {
    // The name cache is a real file — never the developer's own ~/.favro.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-refusal-drift-'));
    process.env.FAVRO_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(resolvers)('%s', async (_name, run) => {
    await expect(run()).rejects.toBeInstanceOf(RefusalError);
  });
});

// ─── the credential absences ─────────────────────────────────────────────────

/**
 * An unset credential is a REFUSAL, not a failure (#118).
 *
 * Not a resolver, so neither arm above reaches it — but it is the same mistake
 * with a wider blast radius, because the runner builds the client before EVERY
 * non-anonymous handler. A bare `Error` here has no HTTP response to classify,
 * so `isRetryable` calls it retryable and an agent is told to repeat a call
 * that needs a key nobody has set. It is also, for a fresh install, the very
 * first error the CLI can produce.
 */
describe('an unset credential refuses rather than inviting a retry', () => {
  const saved = {
    dir: process.env.FAVRO_CONFIG_DIR,
    key: process.env.FAVRO_API_KEY,
    email: process.env.FAVRO_EMAIL,
  };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-no-creds-'));
    process.env.FAVRO_CONFIG_DIR = tmpDir;
    delete process.env.FAVRO_API_KEY;
    delete process.env.FAVRO_EMAIL;
  });

  afterEach(() => {
    for (const [name, value] of [
      ['FAVRO_CONFIG_DIR', saved.dir],
      ['FAVRO_API_KEY', saved.key],
      ['FAVRO_EMAIL', saved.email],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no API key anywhere', async () => {
    await expect(createFavroClient()).rejects.toBeInstanceOf(RefusalError);
  });

  it('a key but no email', async () => {
    process.env.FAVRO_API_KEY = 'a-key';
    // Empty rather than deleted: `createFavroClient` falls back to a fixture
    // address under NODE_ENV=test, and `''` is not nullish so it survives the
    // `??` chain and reaches the guard.
    process.env.FAVRO_EMAIL = '';
    await expect(createFavroClient()).rejects.toBeInstanceOf(RefusalError);
  });

  /**
   * `skill-store.ts` declines the same way and for the same reason: a name
   * nothing matches, or a name that is really a path, refuses identically on
   * every retry. Same fix, same ticket (#118) — the skill commands adopted the
   * runner, so these reach the error envelope now instead of a `logError` line.
   */
  it('a skill nobody has', () => {
    expect(() => loadSkill('definitely-not-a-skill-xyz')).toThrow(RefusalError);
  });

  it('a skill name that is really a path', () => {
    expect(() => getSkillPath('../../etc/passwd')).toThrow(RefusalError);
  });
});

// ─── the candidates are a field, not prose ───────────────────────────────────

describe('the name refusals carry their candidates structurally', () => {
  const entries: NamedRef[] = [
    { id: 'board-a', name: 'Backlog' },
    { id: 'board-b', name: 'Backlog' },
  ];
  const options = (value: string) => ({
    kind: 'boards' as const,
    fetch: async () => entries,
    value,
    label: 'board',
    listCommand: 'favro boards list',
    useIdWith: 'favro boards get <boardId>',
  });

  const refusalFrom = async (value: string): Promise<NameResolutionError> => {
    try {
      await resolveNameToId(options(value));
    } catch (error) {
      return error as NameResolutionError;
    }
    throw new Error(`"${value}" resolved when it should have refused`);
  };

  it('an ambiguous name lists the colliding entries as a field', async () => {
    // A caller that has to regex the message back out of prose is a caller that
    // will get it wrong — the two boards named "Backlog" are data.
    const error = await refusalFrom('Backlog');
    expect(error).toBeInstanceOf(RefusalError);
    expect(error.kind).toBe('ambiguous');
    expect(error.value).toBe('Backlog');
    expect(error.candidates).toEqual(entries);
  });

  it('an unresolvable name carries what IS visible as a field', async () => {
    const error = await refusalFrom('Nothing Named This');
    expect(error).toBeInstanceOf(RefusalError);
    expect(error.kind).toBe('unknown');
    expect(error.candidates).toEqual(entries);
  });
});
