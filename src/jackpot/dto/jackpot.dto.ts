// src/jackpot/dto/jackpot.dto.ts
import {
  IsString, IsOptional, IsNumber, IsInt, IsIn, IsDateString,
  Min, Max, Length, Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

const ToInt = () =>
  Transform(({ value }) => {
    const n = parseInt(value, 10);
    return isNaN(n) ? value : n;
  });

// ── Constants ────────────────────────────────────────────────────
export const JACKPOT_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'AWARDED', 'CANCELLED'] as const;
export type JackpotStatus = typeof JACKPOT_STATUSES[number];

export const JACKPOT_DIGIT_LENGTHS = [6, 7] as const;
export type JackpotDigitLength = 6 | 7;

export const JACKPOT_PERIOD_TYPES = ['WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export type JackpotPeriodType = typeof JACKPOT_PERIOD_TYPES[number];

// ── ADMIN: CREATE JACKPOT SESSION ────────────────────────────────
export class CreateJackpotSessionDto {
  @IsString() @Length(3, 150)
  nameEn!: string;

  @IsOptional() @IsString() @Length(0, 150)
  nameBn?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  descriptionEn?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  descriptionBn?: string;

  @IsOptional() @IsString()
  bannerUrl?: string;

  @IsNumber() @Min(1)
  prizeAmount!: number;

  @IsOptional() @IsString() @Length(2, 10)
  currency?: string;

  /**
   * Game code for the backing jackpot game. Optional — if omitted, defaults
   * to `{digitLength}D_JACKPOT`. If a game with this code already exists it is
   * linked; otherwise it is created at activation. Stored/used uppercased.
   */
  @IsOptional() @IsString() @Length(2, 40)
  @Matches(/^[A-Za-z0-9_]+$/, {
    message: 'gameCode must contain only letters, digits or underscores',
  })
  gameCode?: string;

  /** Per-bet stake limits for this jackpot's game. Optional — default min 10. */
  @IsOptional() @IsNumber() @Min(0.01)
  minBet?: number;

  /** Optional — default max 50000. Must be >= minBet. */
  @IsOptional() @IsNumber() @Min(0.01)
  maxBet?: number;

  /** 6 for 6D game, 7 for 7D game */
  @IsIn(JACKPOT_DIGIT_LENGTHS) @IsInt()
  digitLength!: number;

  /** WEEKLY = Mon→Mon, MONTHLY = 1st→1st, CUSTOM = explicit dates */
  @IsIn(JACKPOT_PERIOD_TYPES)
  periodType!: string;

  /** Required when periodType = CUSTOM; optional otherwise (dates are auto-computed) */
  @IsOptional() @IsDateString()
  startsAt?: string;

  @IsOptional() @IsDateString()
  endsAt?: string;
}

// ── ADMIN: UPDATE SESSION (DRAFT only) ───────────────────────────
export class UpdateJackpotSessionDto {
  @IsOptional() @IsString() @Length(3, 150) nameEn?: string;
  @IsOptional() @IsString() @Length(0, 150) nameBn?: string;
  @IsOptional() @IsString() @Length(0, 2000) descriptionEn?: string;
  @IsOptional() @IsString() @Length(0, 2000) descriptionBn?: string;
  @IsOptional() @IsString() bannerUrl?: string;
  @IsOptional() @IsNumber() @Min(1) prizeAmount?: number;
  @IsOptional() @IsString() @Length(2, 40)
  @Matches(/^[A-Za-z0-9_]+$/, {
    message: 'gameCode must contain only letters, digits or underscores',
  })
  gameCode?: string;
  @IsOptional() @IsNumber() @Min(0.01) minBet?: number;
  @IsOptional() @IsNumber() @Min(0.01) maxBet?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;
}

// ── ADMIN: ADJUST PRIZE MID-EVENT ───────────────────────────────
export class AdjustJackpotPrizeDto {
  /** Positive = add to pool, negative = reduce */
  @IsNumber()
  delta!: number;

  @IsString() @Length(3, 500)
  reason!: string;
}

// ── ADMIN: PUBLISH RESULT ────────────────────────────────────────
export class PublishJackpotResultDto {
  /** Digits only, e.g. "897456" for 6D or "2489874" for 7D */
  @IsString() @Matches(/^\d+$/, { message: 'resultNumber must be digits only' })
  resultNumber!: string;
}

// ── ADMIN: ADD HOT NUMBER ─────────────────────────────────────────
export class AddJackpotHotNumberDto {
  /** Digits only; length validated at service level against session digitLength */
  @IsString() @Matches(/^\d+$/, { message: 'number must be digits only' })
  number!: string;

  @IsOptional() @IsString() @Length(0, 200)
  note?: string;

  @IsOptional() @IsInt() @Min(0) @Max(999)
  priority?: number;
}

// ── USER: PLACE BET ──────────────────────────────────────────────
export class PlaceJackpotBetDto {
  /** Digits only; length validated at service level against session digitLength */
  @IsString() @Matches(/^\d+$/, { message: 'betNumber must be digits only' })
  betNumber!: string;

  @IsNumber() @Min(1)
  betAmount!: number;
}

// ── ADMIN: LIST SESSIONS QUERY ────────────────────────────────────
export class ListJackpotSessionsQueryDto {
  @IsOptional() @IsIn(JACKPOT_STATUSES)
  status?: JackpotStatus;

  @IsOptional() @IsIn(JACKPOT_DIGIT_LENGTHS) @IsInt() @ToInt()
  digitLength?: number;

  @IsOptional() @IsInt() @Min(1) @ToInt()
  page?: number = 1;

  @IsOptional() @IsInt() @Min(1) @Max(200) @ToInt()
  limit?: number = 20;
}

// ── ADMIN/USER: BET LIST QUERY ────────────────────────────────────
export class ListJackpotBetsQueryDto {
  @IsOptional() @IsString()
  resultStatus?: string;

  @IsOptional() @IsInt() @Min(1) @ToInt()
  page?: number = 1;

  @IsOptional() @IsInt() @Min(1) @Max(500) @ToInt()
  limit?: number = 50;
}
