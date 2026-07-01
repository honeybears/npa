import {
  Column,
  Entity,
  Id,
  NPARepository,
  Repository,
} from "@node-persistence-api/core";

@Entity({ name: "users" })
export class User {
  @Id()
  id?: number;

  @Column()
  name!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ name: "created_at", type: "DATETIME(3)" })
  createdAt!: Date;
}

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
    name: string,
  ): Promise<User[]>;

  abstract findTopByEmailAllIgnoreCase(email: string): Promise<User[]>;

  abstract existsByEmailIgnoreCase(email: string): Promise<boolean>;

  abstract countDistinctByEmailIgnoreCase(email: string): Promise<number>;
}
