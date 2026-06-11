// src/promotion-stats/dto/promotion-stats.dto.ts
import { Type } from 'class-transformer';
import {
  IsString, IsOptional, IsDateString, IsInt, IsIn,
} from 'class-validator';

export const QUICK_RANGES = [
  'TODAY', 'YESTERDAY', 'THIS_WEEK', 'LAST_WEEK',
  'THIS_MONTH', 'LAST_MONTH', 'CUSTOM',
] as const;
export type QuickRange = typeof QUICK_RANGES[number];

export const STATUS_FILTERS = ['ACTIVE', 'INACTIVE', 'ALL'] as const;
export type StatusFilter = typeof STATUS_FILTERS[number];

export class StatsQueryDto {
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsIn(QUICK_RANGES) range?: QuickRange;

  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;

  @IsOptional() @Type(() => Number) @IsInt()
  promotionId?: number;

  // Partial promotion-code search (ILIKE).
  @IsOptional() @IsString() code?: string;

  // ACTIVE | INACTIVE | ALL (default ALL).
  @IsOptional() @IsIn(STATUS_FILTERS) status?: StatusFilter;
}