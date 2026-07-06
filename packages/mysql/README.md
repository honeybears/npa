# @node-persistence-api/connector-mysql

MySQL runtime adapter for [Node Persistence API](https://github.com/honeybears/Node-Persistence-API).

## Install

```bash
npm install @node-persistence-api/connector-mysql
```

## Usage

```ts
import mysql from 'mysql2/promise';
import { createNPA } from '@node-persistence-api/core';
import {
  MysqlConnection,
  mysql as npaMysql,
} from '@node-persistence-api/connector-mysql';
import './repositories';
import { UserRepository } from './user.repository';

const pool = mysql.createPool(process.env.DATABASE_URL);
const connection = new MysqlConnection(pool);

const npa = createNPA({
  adapter: npaMysql({ queryable: connection }),
});

const users = npa.get(UserRepository);

await users.save({ name: 'kim' });
await users.findById(1);
await users.findByNameContainingIgnoreCase('ki');
await users.findAll({ orderBy: [{ property: 'name' }] });
```

Pass a transaction-capable connection when repository calls must share a
database transaction:

```ts
import { createNPA, Transaction } from '@node-persistence-api/core';
import { mysql as npaMysql } from '@node-persistence-api/connector-mysql';

const npa = createNPA({
  adapter: npaMysql({ connection: pool }),
});

class UserService {
  private readonly users = npa.get(UserRepository);

  @Transaction()
  async rename(id: number, name: string): Promise<void> {
    await this.users.save({ id, name });
  }
}
```

## Migrations

```bash
npa db push --adapter mysql --url "$DATABASE_URL" --entities "src/**/*.entity.ts"
npa migrate dev --adapter mysql --url "$DATABASE_URL" --entities "src/**/*.entity.ts"
npa migrate deploy --adapter mysql --url "$DATABASE_URL"
```
