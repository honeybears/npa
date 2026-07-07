import { createNPA } from "@node-persistence-api/core";
import { postgresql } from "@node-persistence-api/connector-pg";
import { createConnection } from "./database";
import { UserRepository } from "./user.repository";

async function main(): Promise<void> {
  const connection = await createConnection();
  const npa = createNPA({
    adapter: postgresql({ connection }),
  });
  const users = npa.get(UserRepository);

  console.log("findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc");
  console.log(
    await users.findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
      "KIM",
    ),
  );

  console.log("findFirstByEmailAllIgnoreCase");
  console.log(await users.findFirstByEmailAllIgnoreCase("KIM@EXAMPLE.COM"));

  console.log("existsByEmailIgnoreCase");
  console.log(await users.existsByEmailIgnoreCase("KIM@EXAMPLE.COM"));

  console.log("countDistinctByEmailIgnoreCase");
  console.log(await users.countDistinctByEmailIgnoreCase("KIM@EXAMPLE.COM"));

  await connection.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
