// src/promotion-cms/dto/promotion-cms.dto.ts
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsArray,
  IsDateString,
  Min,
  Max,
  Length,
  ArrayMaxSize,
} from 'class-validator';

// Allowed redirect targets — match the migration constraint
export const REDIRECT_TARGETS = ['PROMO_CENTER', 'DEPOSIT', 'VIP', 'NONE'] as const;
export type RedirectTarget = typeof REDIRECT_TARGETS[number];

// Allowed tags. Free-form, but we whitelist to prevent garbage.
// Add more here as marketing categories grow.
export const ALLOWED_TAGS = [
  'Sport', 'LiveCasino', 'Slot', 'Table', 'Lottery', 'Fishing', 'Crash', 'Arcade',
] as const;
export type CmsTag = typeof ALLOWED_TAGS[number];

export const SUPPORTED_LANGS = ['en', 'bn'] as const;
export type SupportedLang = typeof SUPPORTED_LANGS[number];

// ─── ADMIN: CREATE ──────────────────────────────────────────────
export class CreatePromotionCmsDto {
  @IsOptional()
  @IsInt()
  promotionId?: number;

  @IsOptional()
  @IsString()
  @Length(2, 10)
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sequence?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsIn(ALLOWED_TAGS, { each: true })
  tags?: CmsTag[];

  @IsOptional() @IsBoolean() displayBeforeLogin?: boolean;
  @IsOptional() @IsBoolean() displayAfterLogin?: boolean;
  @IsOptional() @IsBoolean() showRemainingTime?: boolean;
  @IsOptional() @IsBoolean() allowApply?: boolean;

  @IsOptional()
  @IsIn(REDIRECT_TARGETS)
  redirectTarget?: RedirectTarget;

  @IsOptional()
  @IsInt()
  eligibleMemberGroupId?: number;

  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;

  // EN content
  @IsOptional() @IsString() @Length(0, 200) titleEn?: string;
  @IsOptional() @IsString() @Length(0, 1000) descriptionEn?: string;
  @IsOptional() @IsString() contentEn?: string;        // rich HTML

  // BN content
  @IsOptional() @IsString() @Length(0, 200) titleBn?: string;
  @IsOptional() @IsString() @Length(0, 1000) descriptionBn?: string;
  @IsOptional() @IsString() contentBn?: string;

  // Button generation flags
  @IsOptional() @IsBoolean() buttonShowWithTitle?: boolean;
  @IsOptional() @IsBoolean() buttonShowWhenEligible?: boolean;
  @IsOptional() @IsBoolean() buttonShowInPromotions?: boolean;
  @IsOptional() @IsBoolean() buttonShowInPromoCenter?: boolean;

  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ─── ADMIN: UPDATE (all optional) ───────────────────────────────
export class UpdatePromotionCmsDto extends CreatePromotionCmsDto {}

// ─── ADMIN: LIST QUERY ──────────────────────────────────────────
export class ListPromotionCmsQueryDto {
  @IsOptional() @IsString() currency?: string;

  @IsOptional() @IsBoolean() isActive?: boolean;

  @IsOptional()
  @IsIn(ALLOWED_TAGS)
  tag?: CmsTag;

  @IsOptional() @IsInt() @Min(1) page?: number = 1;

  @IsOptional() @IsInt() @Min(1) @Max(200) limit?: number = 20;
}

// ─── USER: PUBLIC FEED QUERY ────────────────────────────────────
export class FeedQueryDto {
  @IsOptional()
  @IsIn(SUPPORTED_LANGS)
  lang?: SupportedLang = 'en';

  @IsOptional()
  @IsBoolean()
  loggedIn?: boolean;

  @IsOptional()
  @IsIn(ALLOWED_TAGS)
  tag?: CmsTag;

  @IsOptional() @IsString() currency?: string;
}

// ─── ADMIN: REORDER (drag-to-reorder) ───────────────────────────
export class ReorderCmsDto {
  // Array of { id, sequence } pairs to update in one call
  @IsArray()
  items: { id: number; sequence: number }[];
}