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
  ValidateNested,
} from 'class-validator';

/**
 * One band in a cashback/rebate percentage ladder. The percentage applies to
 * the ACTUAL basis, not to the band's bound: a 200 loss inside a 0-999 band
 * at 5% pays 10.
 */
export class CashbackTierDto {
  @IsInt() @Min(1) tierNo!: number;

  /** Top of the band. null = unbounded, valid on the last tier only. */
  @IsOptional() @IsNumber() @Min(0) upperAmount?: number | null;

  @IsNumber() @Min(0) @Max(100) percent!: number;
}

// ─── ENUMS / CONSTANTS ──────────────────────────────────────────
export const PROMOTION_KINDS = [
  'DEPOSIT', 'REGISTRATION', 'PROMOCODE', 'MANUAL',
  'FREE_REWARD', 'RELOAD', 'CASHBACK', 'REBATE',
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

// Provider verticals a promotion can target (promotions.eligible_game_categories).
// Keep in sync with CatalogService.CATEGORIES (src/catalog/catalog.service.ts).
// 'FISHING' is kept as a legacy alias of 'FISH' for backward compatibility.
export const GAME_CATEGORIES = [
  'LIVE', 'SLOT', 'FISH', 'EGAMES', 'HORSE', 'COCKFIGHT',
  'SPORTS', 'LOTTERY', 'TABLE', 'ARCADE', 'CRASH', 'OTHER',
  'FISHING',
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
  // REGISTRATION bonuses: days after sign-up the user may still claim. Omit/null = no limit.
  @IsOptional() @IsInt() @Min(0) registerValidDays?: number;

  @IsOptional() @IsInt() memberGroupId?: number;
  // Multiple member groups / VIP tiers the promo applies to. Empty/omitted =
  // open to all (subject to the legacy single memberGroupId if set).
  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true })
  memberGroupIds?: number[];
  // VIP tiers (vip_level_config.level) the promo applies to. Empty/omitted = all tiers.
  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(0, { each: true })
  vipLevels?: number[];
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
  /**
   * Games that never count toward this bonus's turnover, as the
   * "SOURCE:code" keys CatalogService.getGames() returns.
   *
   * Decorated because the global ValidationPipe runs with `whitelist: true`,
   * which strips any property carrying no validation metadata at all — an
   * undecorated field never reaches the service, and the save looks like it
   * worked.
   */
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  excludedGameKeys?: string[];

  /**
   * Which providers clear this bonus's turnover, as the "SOURCE:VENDOR" keys
   * CatalogService.getProviders() returns. Empty = every provider counts;
   * otherwise ONLY the listed ones do.
   *
   * Composes with eligibleGameCategories by AND, so "SLOT" plus
   * "NEXUS:PRAGMATIC" clears on Pragmatic's slots only.
   */
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  eligibleProviders?: string[];


  // ── Cashback / Rebate / Manual ────────────────────────────────────
  // Decorated like everything else here: the global ValidationPipe runs with
  // `whitelist: true`, so an undecorated field is stripped before it reaches
  // the service and the save looks like it worked.

  /** LOSS for cashback and manual, TURNOVER for rebate. */
  @IsOptional() @IsIn(['LOSS', 'TURNOVER'])
  cashbackBasis?: 'LOSS' | 'TURNOVER';

  /** FIXED = one shared cycle; ON_CLAIM = a private cycle per player. */
  @IsOptional() @IsIn(['FIXED', 'ON_CLAIM'])
  cycleStartMode?: 'FIXED' | 'ON_CLAIM';

  @IsOptional() @Transform(emptyToUndefined) @IsDateString()
  cycleStartAt?: string;

  /** Length as a duration, so a repeating cycle cannot drift. */
  @IsOptional() @IsInt() @Min(1)
  cycleLengthMinutes?: number;

  /** Presentation only: DAYS for cashback/rebate, HOURS for manual. */
  @IsOptional() @IsIn(['DAYS', 'HOURS'])
  cycleLengthUnit?: 'DAYS' | 'HOURS';

  @IsOptional() @IsBoolean() cycleRepeat?: boolean;

  /** Payout is always an offset from the cycle's end, never a fixed clock. */
  @IsOptional() @IsInt() @Min(0) payoutDelayMinutes?: number;

  @IsOptional() @IsBoolean() checkMinDeposit?: boolean;
  @IsOptional() @IsBoolean() checkWalletBalance?: boolean;
  @IsOptional() @IsBoolean() checkWithdrawal?: boolean;
  @IsOptional() @IsBoolean() checkBonusAmount?: boolean;

  /** Manual only: gates entry to the promotion at deposit time. */
  @IsOptional() @IsNumber() @Min(0) cashbackMinDeposit?: number;

  @IsOptional() @IsNumber() @Min(0) minPayout?: number;
  @IsOptional() @IsNumber() @Min(0) maxPayout?: number;
  @IsOptional() @IsNumber() @Min(0) cashbackMultiplier?: number;

  /**
   * The percentage bands. `upperAmount` is the TOP of each band — a band runs
   * from the previous one's top to its own, the first starting at zero, and
   * the last may be null meaning unbounded.
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => CashbackTierDto)
  cashbackTiers?: CashbackTierDto[];

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

  // Reward type (FIXED/PERCENTAGE) and bonus category — editable post-create.
  @IsOptional() @IsIn(BONUS_TYPES) bonusType?: BonusType;
  @IsOptional() @IsIn(PROMOTION_KINDS) kind?: PromotionKind;

  @IsOptional() @IsNumber() @Min(0) bonusValue?: number;
  @IsOptional() @IsNumber() @Min(0) minAmount?: number;
  @IsOptional() @IsNumber() @Min(0) applyAmountMin?: number;
  @IsOptional() @IsNumber() @Min(0) maxBonus?: number;
  @IsOptional() @IsNumber() @Min(0) rolloverMultiplier?: number;
  @IsOptional() @IsInt() @Min(0) registerValidDays?: number;
  @IsOptional() @IsInt() memberGroupId?: number;
  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true })
  memberGroupIds?: number[];
  @IsOptional() @IsArray() @ArrayUnique() @IsInt({ each: true }) @Min(0, { each: true })
  vipLevels?: number[];
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
  /**
   * Games that never count toward this bonus's turnover, as the
   * "SOURCE:code" keys CatalogService.getGames() returns.
   *
   * Decorated because the global ValidationPipe runs with `whitelist: true`,
   * which strips any property carrying no validation metadata at all — an
   * undecorated field never reaches the service, and the save looks like it
   * worked.
   */
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  excludedGameKeys?: string[];

  /**
   * Which providers clear this bonus's turnover, as the "SOURCE:VENDOR" keys
   * CatalogService.getProviders() returns. Empty = every provider counts;
   * otherwise ONLY the listed ones do.
   *
   * Composes with eligibleGameCategories by AND, so "SLOT" plus
   * "NEXUS:PRAGMATIC" clears on Pragmatic's slots only.
   */
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true })
  eligibleProviders?: string[];


  // ── Cashback / Rebate / Manual ────────────────────────────────────
  // Decorated like everything else here: the global ValidationPipe runs with
  // `whitelist: true`, so an undecorated field is stripped before it reaches
  // the service and the save looks like it worked.

  /** LOSS for cashback and manual, TURNOVER for rebate. */
  @IsOptional() @IsIn(['LOSS', 'TURNOVER'])
  cashbackBasis?: 'LOSS' | 'TURNOVER';

  /** FIXED = one shared cycle; ON_CLAIM = a private cycle per player. */
  @IsOptional() @IsIn(['FIXED', 'ON_CLAIM'])
  cycleStartMode?: 'FIXED' | 'ON_CLAIM';

  @IsOptional() @Transform(emptyToUndefined) @IsDateString()
  cycleStartAt?: string;

  /** Length as a duration, so a repeating cycle cannot drift. */
  @IsOptional() @IsInt() @Min(1)
  cycleLengthMinutes?: number;

  /** Presentation only: DAYS for cashback/rebate, HOURS for manual. */
  @IsOptional() @IsIn(['DAYS', 'HOURS'])
  cycleLengthUnit?: 'DAYS' | 'HOURS';

  @IsOptional() @IsBoolean() cycleRepeat?: boolean;

  /** Payout is always an offset from the cycle's end, never a fixed clock. */
  @IsOptional() @IsInt() @Min(0) payoutDelayMinutes?: number;

  @IsOptional() @IsBoolean() checkMinDeposit?: boolean;
  @IsOptional() @IsBoolean() checkWalletBalance?: boolean;
  @IsOptional() @IsBoolean() checkWithdrawal?: boolean;
  @IsOptional() @IsBoolean() checkBonusAmount?: boolean;

  /** Manual only: gates entry to the promotion at deposit time. */
  @IsOptional() @IsNumber() @Min(0) cashbackMinDeposit?: number;

  @IsOptional() @IsNumber() @Min(0) minPayout?: number;
  @IsOptional() @IsNumber() @Min(0) maxPayout?: number;
  @IsOptional() @IsNumber() @Min(0) cashbackMultiplier?: number;

  /**
   * The percentage bands. `upperAmount` is the TOP of each band — a band runs
   * from the previous one's top to its own, the first starting at zero, and
   * the last may be null meaning unbounded.
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => CashbackTierDto)
  cashbackTiers?: CashbackTierDto[];

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