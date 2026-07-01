import {
  Column,
  Entity,
  Id,
  ManyToOne,
  NPARepository,
  Repository,
} from "@honeybeaers/npa";

@Entity({ name: "teams" })
export class Team {
  @Id()
  id?: number;

  @Column()
  name!: string;
}

@Entity({ name: "users" })
export class User {
  @Id()
  id?: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column()
  age!: number;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @ManyToOne(() => Team)
  team!: Team;
}

@Repository(User)
export abstract class UserRepository extends NPARepository<User, number> {
  abstract findDistinctTop10ByNameContainingIgnoreCaseOrderByCreatedAtDesc(
    name: string,
  ): Promise<User[]>;

  abstract findByTeamNameAndNameAllIgnoreCase(
    teamName: string,
    name: string,
  ): Promise<User[]>;

  abstract findByAgeIgnoreCase(age: number): Promise<User[]>;
}
