import {
  Column,
  Entity,
  Id,
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
