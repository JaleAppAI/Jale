module.exports = {
  verbose: true,
  testEnvironment: 'node',
  // Resource cap: an uncapped run spawns one ts-jest worker per CPU
  // (~1-1.6 GiB each), which has OOM-killed this workstation mid-suite.
  // Two workers keeps the suite responsive while bounding memory; CI can
  // override with --maxWorkers on the command line if it has headroom.
  maxWorkers: 2,
  workerIdleMemoryLimit: '1GB',
  roots: ['<rootDir>/test/unit'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
