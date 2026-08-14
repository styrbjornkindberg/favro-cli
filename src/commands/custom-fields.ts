/**
 * Custom Fields Commands
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Commands:
 *   favro custom-fields list <board>                 — Custom fields defined on a board
 *   favro custom-fields get <field-id>               — Get custom field details
 *   favro custom-fields set <card> <field-id> <value> — Set custom field value on card
 *   favro custom-fields values <field-id>            — List all possible values for a field
 */
import { Command } from 'commander';
import {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldOption,
  formatFieldType,
} from '../lib/custom-fields-api';
import { confirmAction } from '../lib/safety';
import { dispatch } from '../lib/dispatch';
import { previewOnly } from '../lib/report-dispatch';
import { Ctx, run } from '../lib/run';

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
      '  list <board>                     Custom fields whose definition names a board\n' +
      '  get <field-id>                   Get custom field definition and options\n' +
      '  set <card> <field-id> <value> Set a custom field value on a card\n' +
      '  values <field-id>                List all allowed values for a select field\n\n' +
      'Examples:\n' +
      '  favro custom-fields list <board>\n' +
      '  favro custom-fields get <field-id>\n' +
      '  favro custom-fields set <card> <field-id> "In Progress"\n' +
      '  favro custom-fields values <field-id>'
    );

  // ─── custom-fields list <board> ────────────────────────────────────────────
  cfCmd
    .command('list <board>')
    .description('List the custom fields whose definition names a board')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, board: string, options: { limit?: string }) => {
      // The board is SETTLED first. `listFields` filters client-side on
      // `widgetCommonId` — Favro ignores the wire param (measured, see there) —
      // and an unresolved NAME matches no row, so a name forwarded raw would
      // answer zero fields as confidently as the org-wide list it replaced.
      // `resolveBoardId` passes an exact id straight through and refuses an
      // unknown name in the one wording (#82).
      const boardId = await ctx.api.boards.resolveBoardId(board);

      return {
        // The fetch runs to completion; `--limit` cuts the PRINT (#99).
        rows: await ctx.api.customFields.listFields(boardId),
        limit: options.limit,
        human: (fields: CustomFieldDefinition[]) => {
          console.log(`Found ${fields.length} custom field(s) defined on board ${boardId}:`);
          formatFieldsTable(fields);
        },
      };
    }));

  // ─── custom-fields get <field-id> ──────────────────────────────────────────
  cfCmd
    .command('get <field-id>')
    .description('Get details for a specific custom field')
    .action(run(async (ctx: Ctx, fieldId: string) => ({
      item: await ctx.api.customFields.getField(fieldId),
      human: formatFieldDetail,
    })));

  // ─── custom-fields set <card> <field-id> <value> ────────────────────────
  cfCmd
    .command('set <card> <field-id> <value>')
    .description(
      'Set a custom field value on a card.\n\n' +
      'For select fields, value must match one of the allowed option names.\n' +
      'For date fields, use ISO 8601 format (e.g. "2024-12-31").\n' +
      'For text/user/link fields, pass the string value directly.'
    )
    .option('--dry-run', 'Preview the write. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      cardId: string,
      fieldId: string,
      value: string,
      options: { dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
        const config = ctx.config;
        const args = { card: cardId, customField: { field: fieldId, value } };

        // A dry run with NO lock configured previews from the intent's own pure
        // `preview()` and touches no wire — see `previewOnly`. #155 pinned this
        // command's dry run at zero requests and no credential, and routing it
        // must not take that away. `ctx.client` is untouched on this arm, which
        // is what keeps the credential deferred (#135).
        if (options.dryRun && !config.scopeCollectionId) {
          previewOnly('update', args, config);
          return;
        }

        if (
          !options.dryRun &&
          !(await confirmAction(`Set custom field ${fieldId} on card ${cardId}?`, { yes: options.yes }))
        ) {
          return { item: { set: false, aborted: true }, human: () => 'Aborted.' };
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
        return {
          dispatch: await dispatch<{ cardId: string; wrote: string[] }>(
            'update',
            args,
            { client: ctx.client, config, force: options.force, dryRun: options.dryRun },
          ),
          // The ✓ is spent on a write the facade OBSERVED, which is why the
          // requested value may be printed here at all: `setFieldValue` matches
          // the echo on `customFieldId` and throws when it does not carry what it
          // sent, so reaching this formatter IS the observation. The old
          // "accepted (200) but UNCONFIRMED" arm is gone with it — that case is
          // now a failure the table reports and `reportDispatch` renders.
          human: () =>
            [
              '✓ Custom field updated successfully.',
              `  Field: ${fieldId}`,
              `  Value: ${value}`,
            ].join('\n'),
        };
    }));

  // ─── custom-fields values <field-id> ────────────────────────────────────────
  cfCmd
    .command('values <field-id>')
    .description('List all possible values (options) for a select-type custom field')
    .option('--board <board-id>', 'Board ID to scope the field lookup')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, fieldId: string, options: { board?: string; limit?: string }) => ({
      // The fetch runs to completion; `--limit` cuts the PRINT (#99).
      rows: await ctx.api.customFields.listFieldValues(fieldId, options.board),
      limit: options.limit,
      human: (opts: CustomFieldOption[]) => {
        if (opts.length === 0) {
          console.log('No options found. This field may not be a select type.');
          return;
        }
        console.log(`Found ${opts.length} option(s) for field ${fieldId}:`);
        formatOptionsTable(opts);
      },
    })));
}

export default registerCustomFieldsCommands;
