import { NPARepository } from "@honeybeaers/npa";
import { User } from "./user.entity";

export abstract class UserRepository extends NPARepository<User, number> {
  abstract findByNa

  abstract findByNaem(name: string): Promise<User[]>;

  abstract findByAgeIgnoreCase(age: number): Promise<User[]>;
}
