import { describe, expect, test } from "@jest/globals";
import { execFileSync } from "node:child_process";
describe("benchmark compare CLI", () => {
  test("comparison benchmark exposes CLI help without optional ORM dependencies", () => {
    const output = execFileSync(process.execPath, ["benchmarks/compare/compare.js", "--help"], {
      encoding: "utf8",
    });

    expect(output).toMatch(/npa,prisma,typeorm/);
    expect(output).toMatch(/--repeat/);
    expect(output).toMatch(/--allow-destructive/);
  });
});
