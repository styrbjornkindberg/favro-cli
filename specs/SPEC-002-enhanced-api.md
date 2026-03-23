# SPEC-002: Favro CLI Enhanced API Endpoints

**Status:** Ready for Development
**Priority:** High
**Effort:** 3-4 weeks
**Owner:** CTO / Backend

---

## Overview

Extend the base Favro CLI wrapper (SPEC-001) with additional API endpoints and features that enable more sophisticated workflows. This spec builds on the MVP API client to support advanced board management, card relationships, custom fields, and webhook integration.

---

## Goals

1. **Complete API coverage** — Expose all major Favro REST API endpoints
2. **Relationship querying** — Navigate cards across boards, collections, and custom field values
3. **Bulk operations** — Batch updates with transactional safety
4. **Custom fields** — Full support for custom field types (text, select, date, user, link)
5. **Webhooks** — Subscribe to board changes for real-time updates

---

## API Endpoints (To Implement)

### Collections Management
```
favro collections list [--format table|json]
favro collections get <id> [--include cards,boards,stats]
favro collections create --name "NAME" --description "DESC"
favro collections update <id> --name "NEW_NAME"
```

### Boards Advanced
```
favro boards get <id> --include custom-fields,cards,members
favro boards list <collection-id> --include stats,velocity
favro boards create <collection-id> --name "NAME" [--type board|list|kanban]
favro boards update <id> --name "NEW" --description "DESC"
```

### Cards Advanced (Relations)
```
favro cards get <id> --include board,collection,custom-fields,links,comments
favro cards list <board-id> --filter "customField:value" --include relations
favro cards link <card-id> --to <card-id> --type depends|blocks|duplicates|relates
favro cards unlink <card-id> --from <card-id>
favro cards move <id> --to-board <board-id> --position top|bottom
```

### Custom Fields
```
favro custom-fields list <board-id>
favro custom-fields get <field-id>
favro custom-fields set <card-id> <field-id> <value>
favro custom-fields values <field-id> [--board <board-id>]
```

### Members & Permissions
```
favro members list [--board <board-id>] [--collection <coll-id>]
favro members add <member-email> --to <board-id|coll-id>
favro members remove <member-id> --from <board-id|coll-id>
favro members permissions <member-id> --board <board-id>
```

### Comments & Activity
```
favro comments list <card-id>
favro comments add <card-id> --text "COMMENT"
favro activity log <board-id> [--since 2h|1d] [--format json]
```

### Webhooks
```
favro webhooks list
favro webhooks create --event card.created|card.updated --target http://endpoint
favro webhooks delete <webhook-id>
```

---

## Enhanced Query Engine

Extend SPEC-001 query parser to support:

```
# Nested queries
favro cards list board:board-name --filter "customField:Priority=High AND status:In Progress"

# Cross-board queries
favro cards search "text" --boards board1,board2 --collections coll1

# Relationship queries
favro cards list board:X --filter "blocks:none" # Cards not blocking anything
favro cards list board:X --filter "depends:board:Y" # Cards depending on board Y

# Date queries
favro cards list board:X --filter "due:today|this-week|overdue"

# Owner/assignee queries
favro cards list board:X --filter "owner:@me OR owner:@unassigned"
```

---

## Bulk Operations

```
favro batch update --from-csv cards.csv
# CSV: card_id, status, owner, due_date, custom_field_x
# Returns: summary of updated cards, failures, warnings

favro batch move --board source-id --to-board target-id --filter "status:Completed"
# Moves all matching cards to target board

favro batch assign --board board-id --filter "status:Backlog" --to @me
# Assign all matching cards to current user
```

---

## Error Handling & Validation

- **Rate limiting:** Respect Favro API rate limits (backoff strategy)
- **Validation:** Pre-validate before API calls (required fields, enum values)
- **Atomicity:** Bulk operations should succeed or fail as a unit
- **Dry-run:** `--dry-run` flag shows what would change without committing

---

## Testing

- [ ] Unit tests for all new API methods
- [ ] Integration tests with real Favro board
- [ ] Rate limit handling (stress test with 1000+ operations)
- [ ] Error recovery (network failures, API timeouts)
- [ ] Bulk operation atomicity (partial failures)

---

## Success Criteria

- All endpoints tested and working
- Custom field operations fully functional
- Relationship queries return correct results
- Bulk operations maintain data integrity
- Dry-run mode accurate
- Error messages helpful for CLI users

---

## Dependencies

- SPEC-001: Base API client (must be complete first)
- Favro API documentation for new endpoints
- Test Favro board with custom fields configured

---

## Next Steps

1. Research additional Favro API endpoints not in MVP
2. Design relationship model for cross-board queries
3. Prototype bulk operation transaction handling
4. Submit for CTO review
