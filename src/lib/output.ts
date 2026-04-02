/**
 * LLM-first output utility for v2 commands.
 * New v2 commands default to JSON output; use --human for formatted tables.
 */

export type OutputFormat = 'json' | 'human';

export interface OutputOptions {
  format: OutputFormat;
  pretty?: boolean;
}

/**
 * Output structured data in the requested format.
 * JSON mode: writes compact (or pretty) JSON to stdout.
 * Human mode: delegates to the provided formatter callback.
 */
export function outputResult(
  data: unknown,
  opts: OutputOptions,
  humanFormatter?: (data: any) => string,
): void {
  if (opts.format === 'json') {
    const json = opts.pretty
      ? JSON.stringify(data, null, 2)
      : JSON.stringify(data);
    process.stdout.write(json + '\n');
  } else if (humanFormatter) {
    process.stdout.write(humanFormatter(data) + '\n');
  } else {
    // Fallback: pretty JSON when no human formatter provided
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

/**
 * Resolve output format from CLI flags.
 * v2 commands: default JSON, --human for formatted output.
 */
export function resolveFormat(flags: { human?: boolean; json?: boolean }): OutputFormat {
  if (flags.human) return 'human';
  if (flags.json) return 'json';
  return 'json'; // LLM-first default for v2 commands
}
