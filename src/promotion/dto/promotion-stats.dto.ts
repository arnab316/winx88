// src/promotion/dto/promotion-stats.dto.ts
import { IsOptional, IsDateString, IsString, IsIn } from 'class-validator';

/**
 * Date filter shortcuts matching screenshot 5:
 *   Today / Yesterday / This Week / Last Week / This Month / Last Month
 * Or pass explicit `from` + `to` ISO dates for custom ranges.
 */
export const DATE_PRESETS = [
  'TODAY',
  'YESTERDAY',
  'THIS_WEEK',
  'LAST_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'CUSTOM',
] as const;
export type DatePreset = typeof DATE_PRESETS[number];

export class StatsQueryDto {
  @IsOptional()
  @IsIn(DATE_PRESETS)
  preset?: DatePreset;

  @IsOptional()
  @IsDateString()
  from?: string;     // Required if preset is CUSTOM

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE', 'ALL'])
  status?: 'ACTIVE' | 'INACTIVE' | 'ALL';
}