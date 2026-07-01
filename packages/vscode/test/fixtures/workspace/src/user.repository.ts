import { NPARepository } from "@node-persistence-api/core";
import { User } from "./user.entity";

export abstract class UserRepository extends NPARepository<User, number> {
  abstract findByNa

  abstract findByNameAndA

  abstract findByTe

  abstract findByNaem(name: string): Promise<User[]>;

  abstract findByNameOrName(name: string, duplicateName: string): Promise<User[]>;

  abstract findByAgeIgnoreCase(age: number): Promise<User[]>;
}
