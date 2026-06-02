// src/promotion-cms/dto/promotion-cms.dto.ts
import { Type, Transform } from 'class-transformer';
import {
  IsString, IsOptional, IsBoolean, IsInt, IsIn,
  IsArray, IsDateString, Min, Max, Length,
} from 'class-validator';
import { GAME_CATEGORIES } from '../../promotion/dto/promotion.dto';
import type {GameCategory} from '../../promotion/dto/promotion.dto';
export const REDIRECT_TARGETS = ['PROMO_CENTER', 'DEPOSIT', 'VIP', 'NONE'] as const;
export type RedirectTarget = typeof REDIRECT_TARGETS[number];

export const NON_ELIGIBLE_DISPLAYS = ['GREY', 'HIDE', 'DISABLED'] as const;
export type NonEligibleDisplay = typeof NON_ELIGIBLE_DISPLAYS[number];

// Query-string → boolean coercion
const toBool = ({ value }: { value: any }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

// ─── ADMIN: CREATE ──────────────────────────────────────────────
export class CreatePromotionCmsDto {
  @IsOptional() @IsInt() promotionId?: number;
  @IsOptional() @IsString() @Length(2, 10) currency?: string;
  @IsOptional() @IsInt() @Min(0) sequence?: number;

  @IsOptional() @IsArray() @IsIn(GAME_CATEGORIES, { each: true })
  tags?: GameCategory[];

  @IsOptional() @IsBoolean() displayBeforeLogin?: boolean;
  @IsOptional() @IsBoolean() displayAfterLogin?: boolean;
  @IsOptional() @IsBoolean() showRemainingTime?: boolean;
  @IsOptional() @IsBoolean() allowApply?: boolean;

  @IsOptional() @IsIn(REDIRECT_TARGETS) redirectTarget?: RedirectTarget;
  @IsOptional() @IsIn(NON_ELIGIBLE_DISPLAYS) nonEligibleDisplay?: NonEligibleDisplay;
  @IsOptional() @IsInt() eligibleMemberGroupId?: number;

  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;

  @IsOptional() @IsString() @Length(0, 200) titleEn?: string;
  @IsOptional() @IsString() descriptionEn?: string;
  @IsOptional() @IsString() contentEn?: string;
  @IsOptional() @IsString() bannerEnUrl?: string;
  @IsOptional() @IsString() smallBannerEnUrl?: string;

  @IsOptional() @IsString() @Length(0, 200) titleBn?: string;
  @IsOptional() @IsString() descriptionBn?: string;
  @IsOptional() @IsString() contentBn?: string;
  @IsOptional() @IsString() bannerBnUrl?: string;
  @IsOptional() @IsString() smallBannerBnUrl?: string;

  @IsOptional() @IsBoolean() buttonShowWithTitle?: boolean;
  @IsOptional() @IsBoolean() buttonShowWhenEligible?: boolean;
  @IsOptional() @IsBoolean() buttonShowInPromotions?: boolean;
  @IsOptional() @IsBoolean() buttonShowInPromoCenter?: boolean;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdatePromotionCmsDto extends CreatePromotionCmsDto {}

// ─── ADMIN: LIST QUERY ──────────────────────────────────────────
export class ListPromotionCmsQueryDto {
  @IsOptional() @IsString() currency?: string;

  @IsOptional() @Transform(toBool) @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsIn(GAME_CATEGORIES) tag?: GameCategory;

  @IsOptional() @Type(() => Number) @IsInt()
  promotionId?: number;

  @IsOptional() @IsString() search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 20;
}

// ─── PUBLIC: USER LIST QUERY ────────────────────────────────────
export class PublicPromotionCmsQueryDto {
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsIn(GAME_CATEGORIES) tag?: GameCategory;
  @IsOptional() @IsString() @Length(2, 5) locale?: string;
}

// ─── ADMIN: REORDER ─────────────────────────────────────────────
export class ReorderPromotionCmsDto {
  @IsArray()
  items: Array<{ id: number; sequence: number }> = [];
}