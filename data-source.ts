import "reflect-metadata";
import { DataSource } from "typeorm";

export const AppDataSource = new DataSource({
  type: process.env.DB_TYPE as any ,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT as any ,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  migrations: ["src/migrations/*.ts"],
});