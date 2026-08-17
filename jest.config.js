module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // Unit tests: exclude __integration__ directory.
  // NOTE `**/__tests__/**/*.ts` collects EVERY `.ts` under `src/__tests__/` as a
  // suite, so a helper module placed there fails for containing no tests. That is
  // deliberate and is why shared fixtures live in `src/test-support/` instead —
  // one home for them, enforced by this glob rather than by convention (#97).
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // The developer's own FAVRO_SCOPE_COLLECTION_ID and FAVRO_API_TOKEN must not
  // reach a suite. Before the framework, not in a hook: suites capture those
  // variables at module scope and restore what they captured. See the file.
  setupFiles: ['<rootDir>/src/test-support/scrub-ambient-env.ts'],
  // Direct process.stdout/stderr writes are not captured by Jest — see the file.
  setupFilesAfterEnv: ['<rootDir>/src/test-support/silence-output.ts'],
  // The run gets a private os.tmpdir(), and must leave it empty. See the files.
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
  testPathIgnorePatterns: ['/node_modules/', '/__integration__/'],
  moduleFileExtensions: ['ts', 'js', 'json']
};
