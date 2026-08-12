/**
 * `tempConfigDir`'s own check (#97).
 *
 * `tempConfigDir` is the kind of helper that is easy to make unfalsifiable: it
 * both creates the fixture and registers the cleanup, and a cleanup that does
 * nothing looks exactly like one that works from inside the suite it cleans up
 * after. So the two halves are asserted from different scopes:
 *
 *   - what it SET UP, from a test inside the block that called it;
 *   - what it TORE DOWN, from a root `afterAll`, which Jest runs only after the
 *     inner block's `afterAll` — the earliest point where the removal and the
 *     env restore are observable at all.
 *
 * Nothing here mocks `fs`. A helper checked against a mock of the very thing it
 * uses would pass with an empty body.
 */
import * as fs from 'fs';
import * as path from 'path';
import { tempConfigDir } from '../test-support/config-dir';

/** Every directory handed out, read back after teardown. */
const created: string[] = [];
const OUTER = process.env.FAVRO_CONFIG_DIR;

const make = (prefix: string, config?: unknown): string => {
  const d = config === undefined ? tempConfigDir(prefix) : tempConfigDir(prefix, config);
  created.push(d);
  return d;
};

describe('tempConfigDir', () => {
  // At block scope, mirroring the module-scope call the real suites make.
  const dir = make('favro-stand-selfcheck-', { scopeCollectionId: 'coll-1' });

  it('creates a real directory', () => {
    expect(dir).not.toBe('');
    expect(fs.existsSync(dir)).toBe(true);
    // Which directory FAVRO_CONFIG_DIR ends up naming is asserted below, not
    // here: every call in this block runs at collection time, before any test,
    // so by the time a test body runs the last call has already won.
  });

  it('writes the given config as config.json inside it', () => {
    const written = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    expect(JSON.parse(written)).toEqual({ scopeCollectionId: 'coll-1' });
  });

  // Both at block scope, not inside an `it`. Registering the teardown is part of
  // the call, and Jest rejects a hook defined inside a running test — so
  // "module or describe scope only" is enforced, not merely advised.
  const defaulted = make('favro-stand-selfcheck-default-');
  const twinA = make('favro-stand-selfcheck-unique-');
  const twinB = make('favro-stand-selfcheck-unique-');

  it('defaults to an empty config object', () => {
    expect(fs.readFileSync(path.join(defaulted, 'config.json'), 'utf8')).toBe('{}');
  });

  it('gives each call its own directory', () => {
    expect(twinA).not.toBe(twinB);
    expect(fs.existsSync(twinA)).toBe(true);
    expect(fs.existsSync(twinB)).toBe(true);
  });

  it('leaves FAVRO_CONFIG_DIR at the last call, so one call per suite is the contract', () => {
    expect(process.env.FAVRO_CONFIG_DIR).toBe(twinB);
  });
});

// The only scope from which the registered cleanup is observable. Throwing here
// fails the suite, so a no-op teardown cannot pass.
afterAll(() => {
  if (created.length === 0) {
    throw new Error('tempConfigDir was never called — nothing was checked');
  }
  const survivors = created.filter((d) => fs.existsSync(d));
  if (survivors.length > 0) {
    throw new Error(`tempConfigDir did not remove: ${survivors.join(', ')}`);
  }
  // Order-independent: four calls were made, and the baseline must come back
  // regardless of the order Jest ran their teardowns in.
  if (process.env.FAVRO_CONFIG_DIR !== OUTER) {
    throw new Error(
      `tempConfigDir did not restore FAVRO_CONFIG_DIR: expected ${String(OUTER)}, ` +
        `got ${String(process.env.FAVRO_CONFIG_DIR)}`
    );
  }
});
