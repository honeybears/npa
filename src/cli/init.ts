import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { NPAConfigurationError } from "../error";

type InitDatabase = "postgresql" | "mysql";

interface InitOptions {
  db?: InitDatabase;
  example: boolean;
}

interface WrittenFile {
  path: string;
  status: "created" | "skipped";
}

const DATABASE_CHOICES: Array<{ label: string; value: InitDatabase }> = [
  { label: "PostgreSQL", value: "postgresql" },
  { label: "MySQL", value: "mysql" },
];

export async function runInitCommand(args: string[], cwd: string): Promise<void> {
  const options = await parseInitOptions(args);
  const db = options.db ?? await promptDatabase();
  const files = writeInitFiles(cwd, { ...options, db });

  process.stdout.write(`Initialized NPA for ${db}.\n`);

  for (const file of files) {
    process.stdout.write(`${file.status}: ${relativePath(cwd, file.path)}\n`);
  }
}

async function parseInitOptions(args: string[]): Promise<InitOptions> {
  const options: InitOptions = { example: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--example") {
      options.example = true;
      continue;
    }

    if (arg === "--db") {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) {
        throw invalidInitArgument("--db requires pg, postgresql, or mysql.");
      }

      options.db = parseDatabase(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--db=")) {
      options.db = parseDatabase(arg.slice("--db=".length));
      continue;
    }

    throw invalidInitArgument(`Unsupported init option "${arg}".`);
  }

  return options;
}

function parseDatabase(value: string): InitDatabase {
  if (value === "pg" || value === "postgres" || value === "postgresql") {
    return "postgresql";
  }

  if (value === "mysql") {
    return "mysql";
  }

  throw invalidInitArgument("Migration adapter must be postgresql or mysql.");
}

async function promptDatabase(): Promise<InitDatabase> {
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    process.stdout.write("Select a database:\n");

    DATABASE_CHOICES.forEach((choice, index) => {
      process.stdout.write(`  ${index + 1}. ${choice.label}\n`);
    });

    const answer = (await rl.question("Database [1]: ")).trim() || "1";
    const choice = DATABASE_CHOICES[Number(answer) - 1];

    if (!choice) {
      throw invalidInitArgument("Database selection must be 1 or 2.");
    }

    return choice.value;
  } finally {
    rl.close();
  }
}

function writeInitFiles(
  cwd: string,
  options: Required<InitOptions>,
): WrittenFile[] {
  const files: WrittenFile[] = [
    writeFileIfMissing(
      cwd,
      "npa.config.mjs",
      configTemplate(options.db),
    ),
    writeFileIfMissing(cwd, ".env.example", envTemplate(options.db)),
  ];

  if (!options.example) {
    return files;
  }

  files.push(
    writeFileIfMissing(cwd, "src/user.entity.ts", entityTemplate()),
    writeFileIfMissing(cwd, "src/user.repository.ts", repositoryTemplate()),
    writeFileIfMissing(cwd, "src/repositories.ts", repositoriesTemplate()),
  );

  return files;
}

function writeFileIfMissing(
  cwd: string,
  fileName: string,
  content: string,
): WrittenFile {
  const filePath = path.join(cwd, fileName);

  if (fs.existsSync(filePath)) {
    return { path: filePath, status: "skipped" };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { path: filePath, status: "created" };
}

function configTemplate(db: InitDatabase): string {
  return `export default {
  adapter: ${JSON.stringify(db)},
  url: process.env.DATABASE_URL,
  entities: ["src/**/*.entity.ts"],
  migrations: {
    table: "_npa_migrations",
  },
};
`;
}

function envTemplate(db: InitDatabase): string {
  const url = db === "postgresql"
    ? "postgresql://postgres:postgres@localhost:5432/npa"
    : "mysql://root:root@localhost:3306/npa";

  return `DATABASE_URL=${url}
`;
}

function entityTemplate(): string {
  return `import {
  Column,
  Entity,
  Id,
} from "@node-persistence-api/core";

@Entity({ name: "users" })
export class User {
  @Id()
  id?: number;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ name: "created_at" })
  createdAt!: Date;
}
`;
}

function repositoryTemplate(): string {
  return `import {
  NPARepository,
  Repository,
} from "@node-persistence-api/core";
import { User } from "./user.entity";

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findByEmailIgnoreCase(email: string): Promise<User[]>;

  abstract existsByEmailIgnoreCase(email: string): Promise<boolean>;
}
`;
}

function repositoriesTemplate(): string {
  return `export { UserRepository } from "./user.repository";
`;
}

function invalidInitArgument(message: string): NPAConfigurationError {
  return new NPAConfigurationError(message, {
    code: "NPA_INVALID_CONFIG",
  });
}

function relativePath(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || ".";
}
