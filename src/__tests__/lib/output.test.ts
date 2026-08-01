/**
 * Unit tests — output format resolution and emission (src/lib/output.ts).
 *
 * Migrated from the retired vitest `tests/` tree (#71). Only the two blocks
 * that exercised real code came across; the health/workload/next blocks in the
 * original file re-implemented their formulas inside the test and asserted
 * against their own copy, so they could not fail when the implementation did.
 */

import { resolveFormat, outputResult } from '../../lib/output';

describe('resolveFormat', () => {
  it('defaults to json when no flags', () => {
    expect(resolveFormat({})).toBe('json');
  });

  it('returns human when --human flag is set', () => {
    expect(resolveFormat({ human: true })).toBe('human');
  });

  it('returns json when --json flag is set', () => {
    expect(resolveFormat({ json: true })).toBe('json');
  });

  it('human takes precedence if both set', () => {
    expect(resolveFormat({ human: true, json: true })).toBe('human');
  });
});

describe('outputResult', () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('outputs JSON by default', () => {
    const data = { foo: 'bar' };
    outputResult(data, { format: 'json' });
    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(data) + '\n');
  });

  it('calls human formatter when format is human', () => {
    const data = { foo: 'bar' };
    const formatter = jest.fn(() => 'human output');
    outputResult(data, { format: 'human' }, formatter);
    expect(formatter).toHaveBeenCalledWith(data);
    expect(writeSpy).toHaveBeenCalledWith('human output\n');
  });

  it('falls back to JSON when no human formatter provided', () => {
    const data = [1, 2, 3];
    outputResult(data, { format: 'human' });
    expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2) + '\n');
  });
});
