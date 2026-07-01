import { Column, Entity, Id } from "@honeybeaers/npa";

@Entity({ name: "users" })
export class User {
  @Id()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;
}
