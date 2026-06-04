// src/reports/dto/reports.dto.ts
import { Type } from 'class-transformer';
import { IsOptional, IsString, IsInt, IsDateString, Min, Max } from 'class-validator';

// ─── ADMIN: per-player report list query ────────────────────────
export class PlayerReportQueryDto {
  @IsOptional() @IsString()
  search?: string; // username / user_code / full_name

  @IsOptional() @IsDateString()
  startDate?: string; // ISO; bounds deposit/withdrawal/bet aggregates

  @IsOptional() @IsDateString()
  endDate?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 50;
}

// ─── ADMIN: drill-down list query (bets / transactions) ─────────
export class PlayerDrillQueryDto {
  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  endDate?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 50;
}
