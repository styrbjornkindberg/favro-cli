/**
 * Progress Indicators
 * CLA-1771 FAVRO-011: Error Handling & User Feedback
 *
 * Simple progress reporting for bulk operations. Prints in real-time to stderr
 * so it doesn't interfere with stdout output (JSON, CSV, etc.).
 */

/**
 * ProgressBar — reports progress for bulk operations.
 *
 * Usage:
 *   const bar = new ProgressBar('Creating cards', total);
 *   bar.tick();     // increment by 1
 *   bar.update(n);  // set absolute value
 *   bar.done();     // print final summary
 */
export class ProgressBar {
  private label: string;
  private total: number;
  private current: number;
  private lastLine = '';

  constructor(label: string, total: number) {
    this.label = label;
    this.total = total;
    this.current = 0;
  }

  /**
   * Increment progress by 1 and re-render.
   */
  tick(): void {
    this.update(this.current + 1);
  }

  /**
   * Set absolute progress value and re-render.
   */
  update(current: number): void {
    this.current = Math.min(current, this.total);
    this.render();
  }

  /**
   * Print the final "done" message.
   */
  done(message?: string): void {
    const finalMsg = message ?? `${this.label}... done (${this.total})`;
    // Clear the progress line and print final message
    process.stderr.write(`\r${' '.repeat(this.lastLine.length)}\r`);
    console.error(`✓ ${finalMsg}`);
    this.lastLine = '';
  }

  /**
   * Report progress as "label... current/total"
   */
  report(current: number, total: number): void {
    this.current = current;
    this.total = total;
    this.render();
  }

  private render(): void {
    const line = `${this.label}... ${this.current}/${this.total}`;
    // Clear previous line and overwrite
    process.stderr.write(`\r${' '.repeat(this.lastLine.length)}\r${line}`);
    this.lastLine = line;
  }
}

/**
 * Simple spinner for indeterminate operations.
 */
export class Spinner {
  private label: string;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;
  private interval?: ReturnType<typeof setInterval>;
  private lastLine = '';

  constructor(label: string) {
    this.label = label;
  }

  start(): void {
    this.interval = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length];
      const line = `${frame} ${this.label}...`;
      process.stderr.write(`\r${' '.repeat(this.lastLine.length)}\r${line}`);
      this.lastLine = line;
      this.frameIndex++;
    }, 80);
    // Don't prevent process from exiting if spinner is still running
    if (this.interval && typeof this.interval === 'object' && 'unref' in this.interval) {
      (this.interval as NodeJS.Timeout).unref();
    }
  }

  stop(message?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    process.stderr.write(`\r${' '.repeat(this.lastLine.length)}\r`);
    if (message) {
      console.error(message);
    }
    this.lastLine = '';
  }

  succeed(message?: string): void {
    this.stop(message ? `✓ ${message}` : `✓ ${this.label}`);
  }

  fail(message?: string): void {
    this.stop(message ? `✗ ${message}` : `✗ ${this.label}`);
  }
}

export default ProgressBar;
