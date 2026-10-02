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

import {
  SHORTCUT_BADGES,
  SHORTCUT_TARGET_TYPES,
  type ShortcutBadge,
  type ShortcutTargetType,
} from '../home-shortcuts.service';

/**
 * These arrive as multipart/form-data (the icon is uploaded alongside), so
 * every scalar lands as a string and has to be coerced before validation.
 */
const toBool = ({ value }: { value: any }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : value === true || value === 'true' || value === '1';

const toInt = ({ value }: { value: any }) =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

/** '' and 'null' mean "clear the badge"; absent means "leave it alone". */
const toBadge = ({ value }: { value: any }) =>
  value === '' || value === 'null' ? null : (value ?? undefined);

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
