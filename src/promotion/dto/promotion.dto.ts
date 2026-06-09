// src/promotion/dto/promotion.dto.ts
import { Type, Transform } from 'class-transformer';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsInt,
  IsIn,
  IsArray,
  IsDateString,
  Min,
  Max,
  Length,
  Matches,
  ArrayUnique,
} from 'class-validator';

// ─── ENUMS / CONSTANTS ──────────────────────────────────────────
export const PROMOTION_KINDS = [
  'DEPOSIT', 'REGISTRATION', 'PROMOCODE', 'MANUAL',
  'FREE_REWARD', 'RELOAD', 'CASHBACK',
] as const;
export type PromotionKind = typeof PROMOTION_KINDS[number];

export const BONUS_TYPES = ['PERCENT', 'FLAT'] as const;
export type BonusType = typeof BONUS_TYPES[number];

export const BONUS_DESTINATIONS = ['BONUS_BALANCE', 'MAIN_BALANCE'] as const;
export type BonusDestination = typeof BONUS_DESTINATIONS[number];

export const DEVICE_TYPES = ['DESKTOP', 'MOBILE_WEB', 'APP'] as const;
export type DeviceType = typeof DEVICE_TYPES[number];

export const FREQUENCIES = [
  'ONE_TIME', 'RECURRING_DAILY', 'RECURRING_WEEKLY',
  'RECURRING_MONTHLY', 'UNLIMITED',
] as const;
export type Frequency = typeof FREQUENCIES[number];

export const GAME_CATEGORIES = [
  'LIVE', 'SLOT', 'SPORTS', 'FISHING', 'LOTTERY',
  'TABLE', 'ARCADE', 'CRASH', 'OTHER',
] as const;
export type GameCategory = typeof GAME_CATEGORIES[number];

export const FORFEIT_TYPES = ['BONUS', 'WALLET'] as const;
export type ForfeitType = typeof FORFEIT_TYPES[number];

export const TARGET_TYPES = ['TURNOVER', 'DEPOSIT', 'WIN_LOSS'] as const;
export type TargetType = typeof TARGET_TYPES[number];

export const TARGET_OPTIONS = ['BONUS_AND_APPLY', 'BONUS_ONLY', 'APPLY_ONLY'] as const;
export type TargetOption = typeof TARGET_OPTIONS[number];

export const CAP_LIMIT_TYPES = ['AMOUNT', 'PERCENT'] as const;
export type CapLimitType = typeof CAP_LIMIT_TYPES[number];

// ─── Shared query-string transformers ──────────────────────────
//   Query params arrive as strings ('true', '1'). Coerce before validation.
const toBool = ({ value }: { value: any }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

// Empty form fields arrive as '' (or null). Treat them as "not provided" so an
// empty optional date doesn't fail @IsDateString — the field is simply skipped.
const emptyToUndefined = ({ value }: { value: any }) =>
  value === '' || value === null ? undefined : value;

// ─── ADMIN: CREATE PROMOTION ────────────────────────────────────
export class CreatePromotionDto {
  @IsString() @Length(3, 150)
  title!: string;

  @IsOptional() @IsString() @Length(2, 40)
  @Matches(/^[A-Z0-9_]+$/, { message: 'code must be UPPERCASE letters, digits, underscores' })
  code?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  description?: string;

  @IsIn(PROMOTION_KINDS)
  kind!: PromotionKind;

  @IsIn(BONUS_TYPES)
  bonusType!: BonusType;

  @IsNumber() @Min(0)
  bonusValue: number = 0;

  @IsOptional() @IsNumber() @Min(0) minAmount?: number;
  @IsOptional() @IsNumber() @Min(0) applyAmountMin?: number;
  @IsOptional() @IsNumber() @Min(0) maxBonus?: number;
  @IsOptional() @IsNumber() @Min(0) rolloverMultiplier?: number;

  @IsOptional() @IsInt() memberGroupId?: number;
  @IsOptional() @IsInt() @Min(1) maxUsesPerUser?: number;
  @IsOptional() @IsInt() @Min(1) maxUsesGlobal?: number;
  @IsOptional() @IsNumber() @Min(1) maxBonusPool?: number;

  @IsOptional() @IsString() @Length(2, 10) currency?: string;
  @IsOptional() @IsIn(BONUS_DESTINATIONS) bonusTo?: BonusDestination;

  @IsOptional() @IsBoolean() isActive?: boolean;

  @IsOptional() @Transform(emptyToUndefined) @IsDateString() startsAt?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsDateString() endsAt?: string;

  @IsOptional() @IsArray() @ArrayUnique()
  @IsIn(DEVICE_TYPES, { each: true })
  deviceTypes?: DeviceType[];

  @IsOptional() @IsIn(FREQUENCIES) frequency?: Frequency;
  @IsOptional() @IsInt() @Min(0) cooldownSeconds?: number;

  @IsOptional() @IsArray() @ArrayUnique()
  @IsIn(GAME_CATEGORIES, { each: true })
  eligibleGameCategories?: GameCategory[];

  @IsOptional() @IsNumber() @Min(0) autoUnlockThreshold?: number;

  @IsOptional() @IsBoolean() uniqueCheckBankAccount?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckEmail?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckIpAddress?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckDeviceFp?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckPhone?: boolean;

  @IsOptional() @IsBoolean() requireEmailVerified?: boolean;
  @IsOptional() @IsBoolean() requirePhoneVerified?: boolean;
  @IsOptional() @IsBoolean() requireProfileVerified?: boolean;

  // ── Code Setting / chaining ──
  @IsOptional() @IsInt() linkedPromotionId?: number;

  // ── Bonus / lifecycle toggles ──
  @IsOptional() @IsBoolean() autoApprove?: boolean;
  @IsOptional() @IsBoolean() autoComplete?: boolean;
  @IsOptional() @IsBoolean() allowCancel?: boolean;
  @IsOptional() @IsNumber() @Min(0) cancelThreshold?: number;
  @IsOptional() @IsBoolean() limitToProvider?: boolean;
  @IsOptional() @IsBoolean() checkByWalletBalance?: boolean;

  // ── Amount Setting ──
  @IsOptional() @IsInt() @Min(1) maxPlayer?: number;
  @IsOptional() @IsNumber() @Min(0) maximumWithdrawal?: number;
  @IsOptional() @IsNumber() @Min(0) balanceRequire?: number;
  @IsOptional() @IsIn(FORFEIT_TYPES) forfeitType?: ForfeitType;
  @IsOptional() @IsNumber() @Min(0) amountCap?: number;
  @IsOptional() @IsBoolean() removeMaxWithdrawLock?: boolean;

  // ── Target Amount (wagering) ──
  @IsOptional() @IsIn(TARGET_TYPES) targetType?: TargetType;
  @IsOptional() @IsIn(TARGET_OPTIONS) targetOption?: TargetOption;
  @IsOptional() @IsIn(CAP_LIMIT_TYPES) capLimitType?: CapLimitType;

  // ── Eligibility / CMS visibility ──
  @IsOptional() @IsBoolean() payLater?: boolean;
  @IsOptional() @IsBoolean() displayIfNonEligible?: boolean;
  @IsOptional() @IsBoolean() hideIfEligible?: boolean;
}

// ─── ADMIN: UPDATE (all optional) ───────────────────────────────
export class UpdatePromotionDto {
  @IsOptional() @IsString() @Length(3, 150) title?: string;
  @IsOptional() @IsString() @Length(0, 2000) description?: string;

  @IsOptional() @IsNumber() @Min(0) bonusValue?: number;
  @IsOptional() @IsNumber() @Min(0) minAmount?: number;
  @IsOptional() @IsNumber() @Min(0) applyAmountMin?: number;
  @IsOptional() @IsNumber() @Min(0) maxBonus?: number;
  @IsOptional() @IsNumber() @Min(0) rolloverMultiplier?: number;
  @IsOptional() @IsInt() memberGroupId?: number;
  @IsOptional() @IsInt() @Min(1) maxUsesPerUser?: number;
  @IsOptional() @IsInt() @Min(1) maxUsesGlobal?: number;
  @IsOptional() @IsNumber() @Min(1) maxBonusPool?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @Transform(emptyToUndefined) @IsDateString() startsAt?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsDateString() endsAt?: string;

  @IsOptional() @IsArray() @ArrayUnique() @IsIn(DEVICE_TYPES, { each: true })
  deviceTypes?: DeviceType[];

  @IsOptional() @IsIn(FREQUENCIES) frequency?: Frequency;
  @IsOptional() @IsInt() @Min(0) cooldownSeconds?: number;

  @IsOptional() @IsArray() @ArrayUnique() @IsIn(GAME_CATEGORIES, { each: true })
  eligibleGameCategories?: GameCategory[];

  @IsOptional() @IsNumber() @Min(0) autoUnlockThreshold?: number;

  @IsOptional() @IsBoolean() uniqueCheckBankAccount?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckEmail?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckIpAddress?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckDeviceFp?: boolean;
  @IsOptional() @IsBoolean() uniqueCheckPhone?: boolean;

  @IsOptional() @IsBoolean() requireEmailVerified?: boolean;
  @IsOptional() @IsBoolean() requirePhoneVerified?: boolean;
  @IsOptional() @IsBoolean() requireProfileVerified?: boolean;

  @IsOptional() @IsInt() linkedPromotionId?: number;

  @IsOptional() @IsBoolean() autoApprove?: boolean;
  @IsOptional() @IsBoolean() autoComplete?: boolean;
  @IsOptional() @IsBoolean() allowCancel?: boolean;
  @IsOptional() @IsNumber() @Min(0) cancelThreshold?: number;
  @IsOptional() @IsBoolean() limitToProvider?: boolean;
  @IsOptional() @IsBoolean() checkByWalletBalance?: boolean;

  @IsOptional() @IsInt() @Min(1) maxPlayer?: number;
  @IsOptional() @IsNumber() @Min(0) maximumWithdrawal?: number;
  @IsOptional() @IsNumber() @Min(0) balanceRequire?: number;
  @IsOptional() @IsIn(FORFEIT_TYPES) forfeitType?: ForfeitType;
  @IsOptional() @IsNumber() @Min(0) amountCap?: number;
  @IsOptional() @IsBoolean() removeMaxWithdrawLock?: boolean;

  @IsOptional() @IsIn(TARGET_TYPES) targetType?: TargetType;
  @IsOptional() @IsIn(TARGET_OPTIONS) targetOption?: TargetOption;
  @IsOptional() @IsIn(CAP_LIMIT_TYPES) capLimitType?: CapLimitType;

  @IsOptional() @IsBoolean() payLater?: boolean;
  @IsOptional() @IsBoolean() displayIfNonEligible?: boolean;
  @IsOptional() @IsBoolean() hideIfEligible?: boolean;
}

// ─── ADMIN: LIST QUERY ──────────────────────────────────────────
//   *** Note the @Type / @Transform decorators — query strings need coercion. ***
export class ListPromotionsQueryDto {
  @IsOptional() @IsIn(PROMOTION_KINDS)
  kind?: PromotionKind;

  @IsOptional() @Transform(toBool) @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsString()
  code?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 20;
}

// ─── USER: CLAIM PROMO CODE ─────────────────────────────────────
export class ClaimPromocodeDto {
  @IsString() @Length(2, 40)
  code: string = '';
}

// ─── ADMIN: MANUAL BONUS ────────────────────────────────────────
export class GrantManualBonusDto {
  @IsInt() userId: number = 0;
  @IsNumber() @Min(1) amount: number = 0;
  @IsOptional() @IsNumber() @Min(0) rolloverMultiplier?: number;
  @IsString() @Length(3, 500) reason: string = '';
  @IsOptional() @IsIn(BONUS_DESTINATIONS) bonusTo?: BonusDestination = 'BONUS_BALANCE';
}

// ─── ADMIN: CANCEL CLAIM ────────────────────────────────────────
export class CancelClaimDto {
  @IsInt() claimId: number = 0;
  @IsString() @Length(3, 500) reason: string = '';
}

// ─── ADMIN: APPROVE CLAIM (manual-approval promos) ──────────────
export class ApproveClaimDto {
  @IsInt() claimId: number = 0;
}

// ─── ADMIN: FORFEIT CLAIM ───────────────────────────────────────
export class ForfeitClaimDto {
  @IsInt() claimId: number = 0;
  @IsIn(FORFEIT_TYPES) forfeitType: ForfeitType = 'BONUS';
  @IsString() @Length(3, 500) reason: string = '';
}