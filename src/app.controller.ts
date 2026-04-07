import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { HealthCheckService, HealthCheck,TypeOrmHealthIndicator  } from '@nestjs/terminus';
import { getSystemHealth } from './Utils';
import { DataSource } from 'typeorm';
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private health: HealthCheckService,
     private db: TypeOrmHealthIndicator,
     private dataSource: DataSource
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @HealthCheck()
  check() {
    // return this.health.check([]);
    return this.health.check([
    () => this.db.pingCheck('postgres'),
  ]);
  }

  @Get('details')
getDetails() {
  return getSystemHealth();
}
 @Get('stats')
 async getStats() {
    const size = await this.dataSource.query(
      `SELECT pg_size_pretty(pg_database_size(current_database()))`
    );

    const tables = await this.dataSource.query(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`
    );

    return {
      dbSize: size[0],
      totalTables: tables[0],
    };
  }
   @Get('tables')
  async getTableSizes() {
    const result = await this.dataSource.query(`
      SELECT
        relname AS table,
        pg_size_pretty(pg_total_relation_size(relid)) AS size
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC;
    `);

    return result;
  }
}
