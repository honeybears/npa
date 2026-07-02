import { NPARepository, Query } from "@node-persistence-api/core";
import { User } from "./user.entity";

export abstract class UserRepository extends NPARepository<User, number> {
  abstract findByNa

  abstract findByNameAndA

  abstract findByTe

  @Query('SELECT * FROM users WHERE email = :em')
  findByEmailSql!: (email: string, active: boolean) => Promise<User | null>;

  @Query('SELECT * FROM users WHERE name = :name')
  findByNameSql(name: string): Promise<User[]> {
    throw new Error("NPA provides @Query implementations");
  }

  abstract findByNaem(name: string): Promise<User[]>;

  abstract findByNameOrName(name: string, duplicateName: string): Promise<User[]>;

  abstract findByAgeIgnoreCase(age: number): Promise<User[]>;
}
