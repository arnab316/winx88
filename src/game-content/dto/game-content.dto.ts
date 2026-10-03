import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { toBool, toInt, toJsonArray } from 'src/common/dto-transforms';
import { GAME_KINDS, type GameKind } from 'src/game-library/game-library.service';
import { GAME_BADGES, type GameBadge, type GameFeature } from '../game-content.service';

/**
 * Sent as multipart (the cover image uploads alongside), so arrays arrive as
 * JSON strings and booleans/numbers as plain strings. See
 * src/common/dto-transforms.ts for why these read the raw value.
 */
export class UpsertGameContentDto {
  @IsIn(GAME_KINDS, { message: `kind must be one of ${GAME_KINDS.join(', ')}` })
  kind!: GameKind;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  providerRef!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  gameCode!: string;

  @IsOptional() @IsString() @MaxLength(255) displayName?: string;
  @IsOptional() @IsString() @MaxLength(150) providerName?: string;
  @IsOptional() @IsString() @MaxLength(500) coverImage?: string;
  @IsOptional() @IsString() aboutEn?: string;
  @IsOptional() @IsString() aboutBn?: string;

  @IsOptional() @Transform(toJsonArray) @IsArray() features?: GameFeature[];
  @IsOptional() @Transform(toJsonArray) @IsArray() screenshots?: string[];
  @IsOptional() @Transform(toJsonArray) @IsArray() badges?: GameBadge[];

  @IsOptional() @Transform(toInt) @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @Transform(toBool) @IsBoolean() isActive?: boolean;
}

export class UpdateGameContentDto {
  @IsOptional() @IsString() @MaxLength(255) displayName?: string;
  @IsOptional() @IsString() @MaxLength(150) providerName?: string;
  @IsOptional() @IsString() @MaxLength(500) coverImage?: string;
  @IsOptional() @IsString() aboutEn?: string;
  @IsOptional() @IsString() aboutBn?: string;

  @IsOptional() @Transform(toJsonArray) @IsArray() features?: GameFeature[];
  @IsOptional() @Transform(toJsonArray) @IsArray() screenshots?: string[];
  @IsOptional() @Transform(toJsonArray) @IsArray() badges?: GameBadge[];

  @IsOptional() @Transform(toInt) @Type(() => Number) @IsInt() sortOrder?: number;
  @IsOptional() @Transform(toBool) @IsBoolean() isActive?: boolean;
}

export class ReorderGameContentDto {
  @IsInt({ each: true })
  @Type(() => Number)
  ids!: number[];
}

/** Exported so the controller can validate the ?badge= query cheaply. */
export const VALID_BADGES: readonly string[] = GAME_BADGES;
