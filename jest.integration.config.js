module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__integration__'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // No `scrub-ambient-env` here, deliberately: `jest.config.js` strips the ambient
  // lock and credential because they are noise to a mocked suite, but these tests
  // do real writes against a real org, where an inherited lock is the guardrail and
  // the inherited token is how they authenticate. Stripping them here would remove
  // a safety net rather than a nuisance.
  // Real network calls against the Favro API, each spawning the CLI via ts-node.
  testTimeout: 120000,
  // Favro rate-limits hard; serial runs keep the suite under the limit.
  maxWorkers: 1
};
