import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { toBool, toInt, toNullableEnum as toBadge } from 'src/common/dto-transforms';
import {
  SHORTCUT_BADGES,
  SHORTCUT_TARGET_TYPES,
  type ShortcutBadge,
  type ShortcutTargetType,
} from '../home-shortcuts.service';

export class CreateShortcutDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  labelEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  labelBn?: string;

  @IsOptional()
  @Transform(toBadge)
  @IsIn([...SHORTCUT_BADGES, null], {
    message: `badge must be one of ${SHORTCUT_BADGES.join(', ')} or empty`,
  })
  badge?: ShortcutBadge | null;

  @IsIn(SHORTCUT_TARGET_TYPES, {
    message: `targetType must be one of ${SHORTCUT_TARGET_TYPES.join(', ')}`,
  })
  targetType!: ShortcutTargetType;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  targetValue!: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  requiresAuth?: boolean;

  @IsOptional()
  @Transform(toInt)
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;

  /** Used instead of an upload when pointing at an already-hosted image. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  iconUrl?: string;
}

export class UpdateShortcutDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  labelEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  labelBn?: string;

  @IsOptional()
  @Transform(toBadge)
  @IsIn([...SHORTCUT_BADGES, null], {
    message: `badge must be one of ${SHORTCUT_BADGES.join(', ')} or empty`,
  })
  badge?: ShortcutBadge | null;

  @IsOptional()
  @IsIn(SHORTCUT_TARGET_TYPES, {
    message: `targetType must be one of ${SHORTCUT_TARGET_TYPES.join(', ')}`,
  })
  targetType?: ShortcutTargetType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  targetValue?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  requiresAuth?: boolean;

  @IsOptional()
  @Transform(toInt)
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  iconUrl?: string;
}

export class ReorderShortcutsDto {
  @IsInt({ each: true })
  @Type(() => Number)
  ids!: number[];
}
