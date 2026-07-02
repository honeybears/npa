export interface MigrationSafetyIssue {
  statement: string;
  reason: string;
}

export function findDestructiveMigrationStatements(
  statements: string[],
): MigrationSafetyIssue[] {
  return statements.flatMap((statement) => {
    const normalized = normalizeStatement(statement);
    const issues: MigrationSafetyIssue[] = [];

    if (/\bdrop\s+table\b/i.test(normalized)) {
      issues.push({ statement, reason: "drops a table" });
    }

    if (/\bdrop\s+column\b/i.test(normalized)) {
      issues.push({ statement, reason: "drops a column" });
    }

    if (/\btruncate\b/i.test(normalized)) {
      issues.push({ statement, reason: "truncates data" });
    }

    if (/\bdelete\s+from\b/i.test(normalized)) {
      issues.push({ statement, reason: "deletes data" });
    }

    if (/\balter\s+table\b.+\balter\s+column\b.+\btype\b/i.test(normalized)) {
      issues.push({ statement, reason: "changes a column type" });
    }

    if (/\balter\s+table\b.+\bmodify\s+column\b/i.test(normalized)) {
      issues.push({ statement, reason: "modifies a column definition" });
    }

    if (/\balter\s+table\b.+\balter\s+column\b.+\bset\s+not\s+null\b/i.test(normalized)) {
      issues.push({ statement, reason: "tightens column nullability" });
    }

    return issues;
  });
}

export function assertSafeMigrationStatements(
  statements: string[],
  options: { allowDestructive?: boolean } = {},
): void {
  if (options.allowDestructive) {
    return;
  }

  const issues = findDestructiveMigrationStatements(statements);

  if (issues.length === 0) {
    return;
  }

  const details = issues
    .map((issue) => `${issue.reason}: ${issue.statement}`)
    .join("\n");

  throw new Error(
    `Destructive migration statements require --allow-destructive.\n${details}`,
  );
}

function normalizeStatement(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}
