// src/game/dto/game.dto.ts
import {
  IsString, IsOptional, IsBoolean, IsInt, IsNumber, IsIn,
  Min, Max, Length, IsArray, ArrayMinSize,
} from 'class-validator';

export const DISPLAY_CATEGORIES = ['REGULAR', 'JACKPOT', 'INSTANT', 'CUSTOM'] as const;
export type DisplayCategory = typeof DISPLAY_CATEGORIES[number];

// Per your DDL: games_digit_length_check CHECK (digit_length IN (1, 3, 4, 5))
export const VALID_DIGIT_LENGTHS = [1, 3, 4, 5] as const;
export type DigitLength = typeof VALID_DIGIT_LENGTHS[number];

export const ROUND_STATUSES = ['OPEN', 'CLOSED', 'RESULT_PUBLISHED', 'SETTLED'] as const;
export type RoundStatus = typeof ROUND_STATUSES[number];

// ─── ADMIN: TOGGLE GAME FLAGS ───────────────────────────────────
export class UpdateGameFlagsDto {
  @IsOptional() @IsBoolean() isHot?: boolean;
  @IsOptional() @IsBoolean() isJackpotBadge?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;

  @IsOptional() @IsIn(DISPLAY_CATEGORIES)
  displayCategory?: DisplayCategory;

  @IsOptional() @IsInt() @Min(0) @Max(9999)
  hotPriority?: number;

  @IsOptional() @IsNumber() @Min(1)
  maxPayoutPerRound?: number;

  @IsOptional() @IsString() @Length(0, 1000)
  description?: string;

  @IsOptional() @IsString()
  thumbnailUrl?: string;
}

// ─── ADMIN: CREATE HOT NUMBER ───────────────────────────────────
export class CreateHotNumberDto {
  @IsInt()
  gameId: number;

  @IsString() @Length(1, 20)
  number: string;

  @IsOptional() @IsInt() @Min(0) @Max(9999)
  priority?: number = 0;

  @IsOptional() @IsString() @Length(0, 200)
  note?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean = true;
}

// ─── ADMIN: UPDATE HOT NUMBER ───────────────────────────────────
export class UpdateHotNumberDto {
  @IsOptional() @IsString() @Length(1, 20)
  number?: string;

  @IsOptional() @IsInt() @Min(0) @Max(9999)
  priority?: number;

  @IsOptional() @IsString() @Length(0, 200)
  note?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

// ─── ADMIN: BULK REORDER HOT NUMBERS ────────────────────────────
export class ReorderHotNumbersDto {
  @IsArray() @ArrayMinSize(1)
  items: { id: number; priority: number }[];
}

// ─── PUBLIC: LIST GAMES QUERY ───────────────────────────────────
export class ListGamesQueryDto {
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isHot?: boolean;
  @IsOptional() @IsBoolean() isJackpotBadge?: boolean;

  @IsOptional() @IsIn(DISPLAY_CATEGORIES)
  category?: DisplayCategory;

  @IsOptional() @IsIn(VALID_DIGIT_LENGTHS)
  digitLength?: DigitLength;     // 1D, 3D, 4D, 5D filter
}

// ─── PUBLIC: LIST ROUNDS QUERY ──────────────────────────────────
export class ListRoundsQueryDto {
  @IsOptional() @IsIn(ROUND_STATUSES)
  status?: RoundStatus;
 
  @IsOptional() @IsString()
  date?: string;          // 'today' | 'YYYY-MM-DD'
 
  @IsOptional() @IsInt() @Min(1) @Max(200)
  limit?: number = 50;
}
 
 
