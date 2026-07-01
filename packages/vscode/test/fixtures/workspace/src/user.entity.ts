import { Column, Entity, Id, ManyToOne } from "@honeybeaers/npa";

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
