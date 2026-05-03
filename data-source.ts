import 'dotenv/config';
import 'reflect-metadata';
import { DataSource } from 'typeorm';


export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  username: process.env.DB_USER,
  password: process.env.DB_PASS?.trim() || '',
  database: process.env.DB_NAME,
  migrations: ['src/migrations/*.ts'],
});