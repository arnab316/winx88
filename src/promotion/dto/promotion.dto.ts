// src/promotion/dto/promotion.dto.ts
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsInt,
  IsIn,
  IsDateString,
  Min,
  Max,
  Length,
  Matches,
} from 'class-validator';

// Promotion kinds we're building NOW (per your decision)
export const PROMOTION_KINDS = ['DEPOSIT', 'REGISTRATION', 'PROMOCODE', 'MANUAL'] as const;
export type PromotionKind = typeof PROMOTION_KINDS[number];

// Bonus types from your DDL
export const BONUS_TYPES = ['PERCENT', 'FLAT'] as const;
export type BonusType = typeof BONUS_TYPES[number];

// Where the bonus money goes
export const BONUS_DESTINATIONS = ['BONUS_BALANCE', 'MAIN_BALANCE'] as const;
export type BonusDestination = typeof BONUS_DESTINATIONS[number];

// ─── ADMIN: CREATE PROMOTION ────────────────────────────────────
export class CreatePromotionDto {
  @IsString()
  @Length(3, 150)
  title: string;

  @IsOptional()
  @IsString()
  @Length(2, 40)
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'code must be UPPERCASE letters, digits, underscores',
  })
  code?: string;     // required for PROMOCODE kind, optional for others

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsIn(PROMOTION_KINDS)
  kind: PromotionKind ;

  @IsIn(BONUS_TYPES)
  bonusType: BonusType;

  // For PERCENT: 0-100 (e.g. 50 = 50%)
  // For FLAT: any positive amount (e.g. 100 = ৳100 fixed)
  @IsNumber()
  @Min(0)
  bonusValue: number = 0;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minAmount?: number = 0;       // min deposit to qualify (DEPOSIT kind)

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxBonus?: number = 0;        // cap on per-claim bonus

  @IsOptional()
  @IsNumber()
  @Min(0)
  rolloverMultiplier?: number;   // 0 = no turnover req, 3 = 3x rollover

  @IsOptional()
  @IsInt()
  memberGroupId?: number;        // null = all members eligible

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsesPerUser?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsesGlobal?: number;        // null = unlimited

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxBonusPool?: number;         // null = unlimited

  @IsOptional()
  @IsString()
  @Length(2, 10)
  currency?: string = 'BDT';

  @IsOptional()
  @IsIn(BONUS_DESTINATIONS)
  bonusTo?: BonusDestination = 'BONUS_BALANCE';

  @IsOptional()
  @IsBoolean()
  isActive?: boolean = true;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

// ─── ADMIN: UPDATE (all optional) ───────────────────────────────
export class UpdatePromotionDto {
  @IsOptional() @IsString() @Length(3, 150)
  title?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  description?: string;

  @IsOptional() @IsNumber() @Min(0)
  bonusValue?: number;

  @IsOptional() @IsNumber() @Min(0)
  minAmount?: number;

  @IsOptional() @IsNumber() @Min(0)
  maxBonus?: number;

  @IsOptional() @IsNumber() @Min(0)
  rolloverMultiplier?: number;

  @IsOptional() @IsInt()
  memberGroupId?: number;

  @IsOptional() @IsInt() @Min(1)
  maxUsesPerUser?: number;

  @IsOptional() @IsInt() @Min(1)
  maxUsesGlobal?: number;

  @IsOptional() @IsNumber() @Min(1)
  maxBonusPool?: number;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsDateString()
  startsAt?: string;

  @IsOptional() @IsDateString()
  endsAt?: string;
}

// ─── ADMIN: LIST QUERY ──────────────────────────────────────────
export class ListPromotionsQueryDto {
  @IsOptional() @IsIn(PROMOTION_KINDS)
  kind?: PromotionKind;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @IsInt() @Min(1) @Max(200)
  limit?: number = 20;
}

// ─── USER: CLAIM PROMO CODE ─────────────────────────────────────
export class ClaimPromocodeDto {
  @IsString()
  @Length(2, 40)
  code: string = '';
}

// ─── ADMIN: MANUAL BONUS ────────────────────────────────────────
export class GrantManualBonusDto {
  @IsInt()
  userId: number =0;

  @IsNumber()
  @Min(1)
  amount: number =0;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rolloverMultiplier?: number;

  @IsString()
  @Length(3, 500)
  reason: string= '';

  @IsOptional()
  @IsIn(BONUS_DESTINATIONS)
  bonusTo?: BonusDestination = 'BONUS_BALANCE';
}

// ─── ADMIN: CANCEL CLAIM ────────────────────────────────────────
export class CancelClaimDto {
  @IsInt()
  claimId: number = 0;

  @IsString()
  @Length(3, 500)
  reason: string = '';
}