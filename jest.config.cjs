module.exports = {
  clearMocks: true,
  moduleNameMapper: {
    "^@node-persistence-api/core$": "<rootDir>/dist/index.js",
    "^@node-persistence-api/core/(.*)$": "<rootDir>/dist/$1",
  },
  moduleFileExtensions: ["ts", "js", "json"],
  roots: ["<rootDir>/test", "<rootDir>/packages"],
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/test/**/*.test.ts",
    "<rootDir>/packages/*/test/**/*.test.ts",
  ],
  transform: {
    "^.+\\.ts$": ["ts-jest", { diagnostics: false, tsconfig: "tsconfig.test.json" }],
  },
};
