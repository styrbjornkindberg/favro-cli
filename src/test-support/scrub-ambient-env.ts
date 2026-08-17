/**
 * Keep the developer's own environment out of the test run (#174/#175).
 *
 * Two variables, one bug: an ambient value the suite never wrote decides what
 * `readConfig()`/`resolveApiKey()` return, and suites fail for a reason unrelated
 * to the change under test. The rest of the `FAVRO_*` family was measured clean
 * (`FAVRO_API_KEY`, `FAVRO_CONFIG_DIR`, `FAVRO_EMAIL`, `FAVRO_ORGANIZATION_ID`,
 * `FAVRO_TRACKER_DOC` — a full run stays green with each exported), so this is two
 * named deletes rather than a loop over the prefix. A loop would also take
 * `FAVRO_JEST_TMPROOT`, which `jest.global-setup.js` sets and the run needs.
 *
 * `FAVRO_SCOPE_COLLECTION_ID` exists so a shell can hold its own lock, which is
 * the whole point of #174 — so a developer or an agent working on this repo WILL
 * have it exported, and the Jest run inherits it. `lib/config.ts` reads it on
 * every `readConfig()`, so the ambient value walks straight into suites that
 * never mentioned it and fails them for a reason unrelated to the change under
 * test.
 *
 * Measured on `7e8fe93` with `npx jest src/__tests__/run.test.ts`:
 *
 *   - `FAVRO_SCOPE_COLLECTION_ID=coll-ambient` → 4 of 52 failed. Two are the
 *     scope-refusal ratchets (`checkCollectionScope` reaches the env through
 *     `scopeRemedy()`), two are older (`reads the config once`, the `--dry-run`
 *     preview) and predate #175.
 *   - `FAVRO_SCOPE_COLLECTION_ID=` (empty) → **42 of 52 failed**, because an
 *     empty value is an error by design in #174, so every `readConfig()` throws.
 *
 * A `delete` covers both: it removes the name whatever it held.
 *
 * WHY `setupFiles` AND NOT A HOOK. Suites that drive the variable capture it at
 * MODULE scope (`const orig = process.env.FAVRO_SCOPE_COLLECTION_ID`, in
 * `config.test.ts`, `safety.test.ts`, both `scope-env-override*` suites) and put
 * that value back in `afterEach`/`afterAll`. A `beforeAll` scrub runs after those
 * captures, so each teardown would faithfully restore the ambient value and hand
 * it to the next test in the file. Scrubbing before any suite module is evaluated
 * makes the captured baseline `undefined`, which is what those teardowns should
 * be restoring. That is also why this file is not folded into
 * `silence-output.ts`: that one needs `beforeAll`/`afterAll` and therefore
 * `setupFilesAfterEnv`, and it silences output — a different concern with a
 * different lifetime.
 *
 * Suites that assign the variable inside a test or a `beforeEach` are unaffected:
 * both run long after this file.
 *
 * NOT restored on teardown, deliberately. Nothing downstream of a Jest worker
 * reads its environment: the worker exits at the end of the run, and the child
 * CLIs some suites spawn are precisely what must not see the ambient lock.
 */
delete process.env.FAVRO_SCOPE_COLLECTION_ID;

/**
 * `FAVRO_API_TOKEN` is the same bug one variable over, and likelier: it is THE
 * credential for this CLI, `.github/workflows/ci.yml:71` exports it under that
 * exact name, so any shell that authenticated has it. `resolveApiKey`
 * (`lib/config.ts:235`) falls back to it last, after the file's `apiKey`, which is
 * why it poisons exactly the suites asserting that an UNSET credential refuses:
 * measured on `7e8fe93`, `FAVRO_API_TOKEN=ambient-tok npx jest` failed 8 tests
 * across `auth-commands`, `run`, `refusal-drift` and `config.integration`.
 *
 * Suites scrub it one at a time today — 18 `delete process.env.FAVRO_API_KEY`
 * against 11 for the token, and `__tests__/refusal-drift.test.ts:169` is one of the
 * gaps. Deleting it here is the same trade as above: one guard where every suite
 * passes, rather than a rule each new suite has to remember.
 */
delete process.env.FAVRO_API_TOKEN;
