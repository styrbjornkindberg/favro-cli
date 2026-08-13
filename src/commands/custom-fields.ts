/**
 * Custom Fields Commands
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Commands:
 *   favro custom-fields list <board-id>              — List all custom fields for a board
 *   favro custom-fields get <field-id>               — Get custom field details
 *   favro custom-fields set <card> <field-id> <value> — Set custom field value on card
 *   favro custom-fields values <field-id>            — List all possible values for a field
 */
import { Command } from 'commander';
import CustomFieldsAPI, {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldOption,
  formatFieldType,
} from '../lib/custom-fields-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';

// ─── Formatters ──────────────────────────────────────────────────────────────

export function formatFieldsTable(fields: CustomFieldDefinition[]): void {
  if (fields.length === 0) {
    console.log('No custom fields found for this board.');
    return;
  }

  const rows = fields.map(f => ({
    ID: f.fieldId,
    Name: (f.name ?? '—').length > 35 ? (f.name ?? '—').slice(0, 32) + '...' : (f.name ?? '—'),
    Type: formatFieldType(f),
    Required: f.required ? 'yes' : 'no',
  }));

  console.table(rows);
}

export function formatFieldDetail(field: CustomFieldDefinition): void {
  console.log(`ID:       ${field.fieldId}`);
  console.log(`Name:     ${field.name}`);
  console.log(`Type:     ${field.type}`);
  console.log(`Required: ${field.required ? 'yes' : 'no'}`);
  if (field.boardId) console.log(`Board:    ${field.boardId}`);
  if (field.description) console.log(`Desc:     ${field.description}`);
  if (field.options && field.options.length > 0) {
    console.log('Options:');
    for (const opt of field.options) {
      console.log(`  - ${opt.name} (id: ${opt.optionId})`);
    }
  }
}

export function formatFieldValuesTable(values: CustomFieldValue[]): void {
  if (values.length === 0) {
    console.log('No custom field values set on this card.');
    return;
  }

  const rows = values.map(v => ({
    'Field ID': v.fieldId,
    Value: v.displayValue ?? v.value ?? '—',
  }));

  console.table(rows);
}

export function formatOptionsTable(options: CustomFieldOption[]): void {
  if (options.length === 0) {
    console.log('No options defined for this field (may not be a select field).');
    return;
  }

  const rows = options.map(o => ({
    ID: o.optionId,
    Name: o.name,
    Color: o.color ?? '—',
  }));

  console.table(rows);
}

// ─── Command Registration ─────────────────────────────────────────────────────

export function registerCustomFieldsCommands(program: Command): void {
  const cfCmd = program
    .command('custom-fields')
    .description(
      'Custom field operations — list, get, set, and inspect field values.\n\n' +
      'Subcommands:\n' +
      '  list <board-id>                  List all custom fields for a board\n' +
      '  get <field-id>                   Get custom field definition and options\n' +
      '  set <card> <field-id> <value> Set a custom field value on a card\n' +
      '  values <field-id>                List all allowed values for a select field\n\n' +
      'Examples:\n' +
      '  favro custom-fields list <board-id>\n' +
      '  favro custom-fields get <field-id>\n' +
      '  favro custom-fields set <card> <field-id> "In Progress"\n' +
      '  favro custom-fields values <field-id>'
    );

  // ─── custom-fields list <board-id> ─────────────────────────────────────────
  cfCmd
    .command('list <board-id>')
    .description('List all custom fields defined for a board')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (boardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CustomFieldsAPI(client);

        const fields = await api.listFields(boardId);
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(fields, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} custom field(s) for board ${boardId}:`);
          formatFieldsTable(envelope.rows);
          noteTruncation(envelope, fields.length);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── custom-fields get <field-id> ──────────────────────────────────────────
  cfCmd
    .command('get <field-id>')
    .description('Get details for a specific custom field')
    .option('--json', 'Output as JSON')
    .action(async (fieldId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CustomFieldsAPI(client);

        const field = await api.getField(fieldId);

        if (options.json) {
          console.log(JSON.stringify(field, null, 2));
        } else {
          formatFieldDetail(field);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── custom-fields set <card> <field-id> <value> ────────────────────────
  cfCmd
    .command('set <card> <field-id> <value>')
    .description(
      'Set a custom field value on a card.\n\n' +
      'For select fields, value must match one of the allowed option names.\n' +
      'For date fields, use ISO 8601 format (e.g. "2024-12-31").\n' +
      'For text/user/link fields, pass the string value directly.'
    )
    .option('--json', 'Output updated field value as JSON')
    .option('--dry-run', 'Preview the write. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, fieldId: string, value: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const { readConfig } = await import('../lib/config');
        const { confirmAction } = await import('../lib/safety');
        const { dispatch } = await import('../lib/dispatch');
        const { previewOnly, reportDispatch } = await import('../lib/report-dispatch');
        const config = (await readConfig()) ?? {};
        const args = { card: cardId, customField: { field: fieldId, value } };

        // A dry run with NO lock configured previews from the intent's own pure
        // `preview()` and touches no wire — see `previewOnly`. #155 pinned this
        // command's dry run at zero requests and no credential, and routing it
        // must not take that away.
        if (options.dryRun && !config.scopeCollectionId) {
          previewOnly('update', args);
          return;
        }

        const client = await createFavroClient();

        if (
          !options.dryRun &&
          !(await confirmAction(`Set custom field ${fieldId} on card ${cardId}?`, { yes: options.yes }))
        ) {
          console.log('Aborted.');
          process.exit(0);
        }

        // Through the ONE dispatch table (#109). This was the last card write
        // that resolved its value and PUT it in the same un-instrumented call —
        // `CustomFieldsAPI.setFieldValue` — so it had no scope lock of its own
        // beyond the hand-rolled hoist that used to sit above, no boardless-write
        // refusal, and no undo handle.
        //
        // The resolution (option NAME → `[optionId]`, and which payload key the
        // field's type spells) now happens inside the transaction, as
        // `TxCards.customFieldWrite`; the PUT is `TxCards.setFieldValue`, which
        // carries a real compensating write — except on a field that had NO prior
        // value, where a select has no measured spelling for "clear" and the
        // unwind says so rather than sending a write measured to do nothing
        // (#106).
        //
        // The lock runs BEFORE the preview because it runs inside the intent,
        // which takes it before the `dryRun` return — the ordering #155 fixed
        // here by hand is now structural.
        const result = await dispatch<{ cardId: string; wrote: string[] }>(
          'update',
          args,
          { client, config, force: options.force, dryRun: options.dryRun },
        );
        if (reportDispatch(result, options.json)) process.exit(1);
        // `value !== undefined` is what keeps this off a dry run: the table's
        // preview return carries a `preview` and no `value`.
        if (result.outcome !== 'ok' || result.value === undefined) return;

        if (options.json) {
          console.log(JSON.stringify(result.value, null, 2));
        } else {
          // The ✓ is spent on a write the facade OBSERVED, which is why the
          // requested value may be printed here at all: `setFieldValue` matches
          // the echo on `customFieldId` and throws when it does not carry what it
          // sent, so reaching this line IS the observation. The old
          // "accepted (200) but UNCONFIRMED" arm is gone with it — that case is
          // now a failure the table reports and `reportDispatch` has exited on.
          console.log(`✓ Custom field updated successfully.`);
          console.log(`  Field: ${fieldId}`);
          console.log(`  Value: ${value}`);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── custom-fields values <field-id> ────────────────────────────────────────
  cfCmd
    .command('values <field-id>')
    .description('List all possible values (options) for a select-type custom field')
    .option('--board <board-id>', 'Board ID to scope the field lookup')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (fieldId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const client = await createFavroClient();
        const api = new CustomFieldsAPI(client);

        const opts = await api.listFieldValues(fieldId, options.board);
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(opts, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          if (envelope.rows.length === 0) {
            console.log('No options found. This field may not be a select type.');
          } else {
            console.log(`Found ${envelope.rows.length} option(s) for field ${fieldId}:`);
            formatOptionsTable(envelope.rows);
            noteTruncation(envelope, opts.length);
          }
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCustomFieldsCommands;
