// src/game/dto/game.dto.ts
import {
  IsString, IsOptional, IsBoolean, IsInt, IsNumber, IsIn,
  Min, Max, Length, IsArray, ArrayMinSize,
} from 'class-validator';
import { Transform } from 'class-transformer';

// ── Helper: query-string "true"/"false" → real boolean ───────
const ToBoolean = () =>
  Transform(({ value }) => {
    if (value === true  || value === 'true'  || value === '1') return true;
    if (value === false || value === 'false' || value === '0') return false;
    return value;
  });

// ── Helper: query-string "3" → number 3 ─────────────────────
const ToInt = () =>
  Transform(({ value }) => {
    const n = parseInt(value, 10);
    return isNaN(n) ? value : n;
  });

export const DISPLAY_CATEGORIES = ['REGULAR', 'JACKPOT', 'INSTANT', 'CUSTOM'] as const;
export type DisplayCategory = typeof DISPLAY_CATEGORIES[number];

export const VALID_DIGIT_LENGTHS = [1, 3, 4, 5] as const;
export type DigitLength = typeof VALID_DIGIT_LENGTHS[number];

export const ROUND_STATUSES = ['OPEN', 'CLOSED', 'RESULT_PUBLISHED', 'SETTLED'] as const;
export type RoundStatus = typeof ROUND_STATUSES[number];

// ─── ADMIN: TOGGLE GAME FLAGS ────────────────────────────────
export class UpdateGameFlagsDto {
  @IsOptional() @ToBoolean() @IsBoolean() isHot?: boolean;
  @IsOptional() @ToBoolean() @IsBoolean() isJackpotBadge?: boolean;
  @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean;

  @IsOptional() @IsIn(DISPLAY_CATEGORIES)
  displayCategory?: DisplayCategory;

  @IsOptional() @ToInt() @IsInt() @Min(0) @Max(9999)
  hotPriority?: number;

  @IsOptional() @IsNumber() @Min(1)
  maxPayoutPerRound?: number;

  @IsOptional() @IsString() @Length(0, 1000)
  description?: string;

  @IsOptional() @IsString()
  thumbnailUrl?: string;
}

// ─── ADMIN: CREATE HOT NUMBER ────────────────────────────────
export class CreateHotNumberDto {
  @ToInt() @IsInt()
  gameId: number;

  @IsString() @Length(1, 20)
  number: string;

  @IsOptional() @ToInt() @IsInt() @Min(0) @Max(9999)
  priority?: number = 0;

  @IsOptional() @IsString() @Length(0, 200)
  note?: string;

  @IsOptional() @ToBoolean() @IsBoolean()
  isActive?: boolean = true;
}

// ─── ADMIN: UPDATE HOT NUMBER ────────────────────────────────
export class UpdateHotNumberDto {
  @IsOptional() @IsString() @Length(1, 20)
  number?: string;

  @IsOptional() @ToInt() @IsInt() @Min(0) @Max(9999)
  priority?: number;

  @IsOptional() @IsString() @Length(0, 200)
  note?: string;

  @IsOptional() @ToBoolean() @IsBoolean()
  isActive?: boolean;
}

// ─── ADMIN: BULK REORDER HOT NUMBERS ─────────────────────────
export class ReorderHotNumbersDto {
  @IsArray() @ArrayMinSize(1)
  items: { id: number; priority: number }[];
}

// ─── PUBLIC: LIST GAMES QUERY ─────────────────────────────────
export class ListGamesQueryDto {
  // isActive=false possible for admin viewing inactive games.
  // Default (no param) = true enforced in service.
  @IsOptional() @ToBoolean() @IsBoolean() isActive?: boolean;
  @IsOptional() @ToBoolean() @IsBoolean() isHot?: boolean;
  @IsOptional() @ToBoolean() @IsBoolean() isJackpotBadge?: boolean;

  // liveOnly=true → only games with an OPEN round right now (close_time > NOW()).
  // Use for user home screen / lobby. Default false = all active games.
  @IsOptional() @ToBoolean() @IsBoolean() liveOnly?: boolean;

  @IsOptional() @IsIn(DISPLAY_CATEGORIES)
  category?: DisplayCategory;

  @IsOptional() @ToInt() @IsIn(VALID_DIGIT_LENGTHS)
  digitLength?: DigitLength;
}

// ─── PUBLIC: LIST ROUNDS QUERY ────────────────────────────────
export class ListRoundsQueryDto {
  @IsOptional() @IsIn(ROUND_STATUSES)
  status?: RoundStatus;

  @IsOptional() @IsString()
  date?: string;

  @IsOptional() @ToInt() @IsInt() @Min(1) @Max(200)
  limit?: number = 50;
}