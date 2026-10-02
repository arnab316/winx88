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

import { LINK_TARGET_TYPES, type LinkTargetType } from 'src/common/link-target';

/** Multipart form fields arrive as strings, so coerce before validating. */
const toBool = ({ value }: { value: any }) =>
  value === undefined || value === null || value === ''
    ? undefined
    : value === true || value === 'true' || value === '1';

const toInt = ({ value }: { value: any }) =>
  value === undefined || value === null || value === '' ? undefined : Number(value);

export class CreatePromoBannerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  titleEn!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  titleBn?: string;

  @IsIn(LINK_TARGET_TYPES, {
    message: `targetType must be one of ${LINK_TARGET_TYPES.join(', ')}`,
  })
  targetType!: LinkTargetType;

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

  /** Used instead of an upload when the artwork is already hosted. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  imageUrl?: string;
}

export class UpdatePromoBannerDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  titleEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  titleBn?: string;

  @IsOptional()
  @IsIn(LINK_TARGET_TYPES, {
    message: `targetType must be one of ${LINK_TARGET_TYPES.join(', ')}`,
  })
  targetType?: LinkTargetType;

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
  imageUrl?: string;
}

export class ReorderPromoBannersDto {
  @IsInt({ each: true })
  @Type(() => Number)
  ids!: number[];
}
