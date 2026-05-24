// src/game/dto/schedule.dto.ts
import {
  IsInt, IsOptional, IsBoolean, IsString,
  Min, Max, MaxLength,
} from 'class-validator';

// ─────────────────────────────────────────────
// POST  /games/admin/:gameId/schedule  (create)
// PATCH /games/admin/:gameId/schedule  (partial update)
// ─────────────────────────────────────────────
export class CreateScheduleDto {
  /** How often a new round is spawned, in minutes. Min 1, max 1440 (1 day). */
  @IsInt()
  @Min(1)
  @Max(1440)
  intervalMinutes!: number;

  /** How long the betting window stays OPEN (open_time -> close_time).
   *  Must be less than intervalMinutes — enforced at DB level too. */
  @IsInt()
  @Min(1)
  @Max(1440)
  betDurationMinutes!: number;

  /** Gap between close_time and draw_time (admin review window).
   *  0 means draw_time = close_time. */
  @IsInt()
  @Min(0)
  @Max(60)
  drawOffsetMinutes!: number;

  /** Prefix for auto-generated round codes, e.g. "1D", "3D". */
  @IsString()
  @MaxLength(20)
  roundCodePrefix!: string;

  /** When the first round should be created.
   *  ISO-8601 string, defaults to NOW() if omitted. */
  @IsOptional()
  @IsString()
  nextRunAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateScheduleDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  intervalMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  betDurationMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  drawOffsetMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  roundCodePrefix?: string;

  @IsOptional()
  @IsString()
  nextRunAt?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}