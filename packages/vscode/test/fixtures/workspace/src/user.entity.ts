import { Column, Entity, Id, ManyToOne } from "@node-persistence-api/core";

@Entity({ name: "users" })
export class User {
  @Id()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;

  @ManyToOne(() => Team)
  team!: Team;
}

@Entity({ name: "teams" })
export class Team {
  @Id()
  id!: number;

  @Column()
  name!: string;
}
