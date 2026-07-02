import {
  NPARepository,
  Repository,
} from "@node-persistence-api/core";
import { User } from "./user.entity";

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
    name: string,
  ): Promise<User[]>;

  abstract findTopByEmailAllIgnoreCase(email: string): Promise<User[]>;

  abstract existsByEmailIgnoreCase(email: string): Promise<boolean>;

  abstract countDistinctByEmailIgnoreCase(email: string): Promise<number>;
}
