/**
 * Tests for progress.ts
 * CLA-1771 FAVRO-011: Error Handling & User Feedback
 */
import { ProgressBar, Spinner } from '../lib/progress';
import { stripAnsi } from '../lib/theme';

describe('ProgressBar', () => {
  let stderrWrite: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    stderrWrite.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('renders "label... current/total" format on update()', () => {
    const bar = new ProgressBar('Creating cards', 50);
    bar.update(10);
    const written = stderrWrite.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(written);
    expect(plain).toContain('Creating cards');
    expect(plain).toContain('10/50');
  });

  test('tick() increments by 1', () => {
    const bar = new ProgressBar('Updating cards', 20);
    bar.tick();
    bar.tick();
    bar.tick();
    const written = stderrWrite.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(written);
    expect(plain).toContain('Updating cards');
    expect(plain).toContain('3/20');
  });

  test('report() sets current and total', () => {
    const bar = new ProgressBar('Exporting cards', 100);
    bar.report(25, 100);
    const written = stderrWrite.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(written);
    expect(plain).toContain('Exporting cards');
    expect(plain).toContain('25/100');
  });

  test('done() prints final message', () => {
    const bar = new ProgressBar('Creating cards', 5);
    bar.update(5);
    bar.done('All cards created');
    const output = consoleErrorSpy.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(output);
    expect(plain).toContain('✓');
    expect(plain).toContain('All cards created');
  });

  test('done() without message uses default', () => {
    const bar = new ProgressBar('Creating cards', 5);
    bar.done();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Creating cards'));
  });

  test('update() does not exceed total', () => {
    const bar = new ProgressBar('Creating cards', 5);
    bar.update(10); // exceeds total
    const written = stderrWrite.mock.calls.map((c: any[]) => c[0]).join('');
    // Should cap at 5/5
    expect(written).toContain('5/5');
  });
});

describe('Spinner', () => {
  let stderrWrite: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    stderrWrite.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test('start() begins rendering frames', () => {
    const spinner = new Spinner('Loading');
    spinner.start();
    jest.advanceTimersByTime(200);
    const written = stderrWrite.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(written);
    expect(plain).toContain('Loading...');
    spinner.stop();
  });

  test('succeed() prints success message', () => {
    const spinner = new Spinner('Fetching');
    spinner.start();
    spinner.succeed('Done fetching');
    const output = consoleErrorSpy.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(output);
    expect(plain).toContain('✓');
    expect(plain).toContain('Done fetching');
  });

  test('fail() prints failure message', () => {
    const spinner = new Spinner('Connecting');
    spinner.start();
    spinner.fail('Connection refused');
    const output = consoleErrorSpy.mock.calls.map((c: any[]) => c[0]).join('');
    const plain = stripAnsi(output);
    expect(plain).toContain('✗');
    expect(plain).toContain('Connection refused');
  });
});
