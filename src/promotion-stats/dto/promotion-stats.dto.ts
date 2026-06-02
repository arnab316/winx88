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

export class StatsQueryDto {
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsIn(QUICK_RANGES) range?: QuickRange;

  @IsOptional() @IsDateString() startDate?: string;
  @IsOptional() @IsDateString() endDate?: string;

  @IsOptional() @Type(() => Number) @IsInt()
  promotionId?: number;

  @IsOptional() @IsString() code?: string;
}