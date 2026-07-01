export default {
  adapter: "postgresql",
  url: process.env.DATABASE_URL,
  entities: ["src/**/*.entity.ts"],
  migrations: {
    table: "_npa_migrations",
  },
};
