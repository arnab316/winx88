// src/jackpot/dto/jackpot.dto.ts
import {
  IsString, IsOptional, IsNumber, IsInt, IsIn, IsDateString,
  Min, Max, Length, ValidateNested, IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';

export const JACKPOT_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'AWARDED', 'CANCELLED'] as const;
export type JackpotStatus = typeof JACKPOT_STATUSES[number];

// ─── ELIGIBILITY RULES (JSONB shape) ────────────────────────────
export class EligibilityRulesDto {
  @IsOptional() @IsInt() @Min(1)
  minBets?: number;          // e.g. user must place 10+ bets in cycle

  @IsOptional() @IsNumber() @Min(0)
  minTotalBet?: number;      // e.g. user must bet >= ৳5000 in cycle

  @IsOptional() @IsInt() @Min(0) @Max(10)
  minVipLevel?: number;      // e.g. only VIP 3+

  @IsOptional() @IsInt()
  memberGroupId?: number;    // restrict to specific member group
}

// ─── ADMIN: CREATE POOL ─────────────────────────────────────────
export class CreateJackpotPoolDto {
  @IsString() @Length(3, 150)
  nameEn: string;

  @IsOptional() @IsString() @Length(0, 150)
  nameBn?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  descriptionEn?: string;

  @IsOptional() @IsString() @Length(0, 2000)
  descriptionBn?: string;

  @IsOptional() @IsString()
  bannerUrl?: string;

  @IsNumber() @Min(1)
  prizeAmount: number;

  @IsOptional() @IsString() @Length(2, 10)
  currency?: string;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsOptional() @IsObject()
  @ValidateNested() @Type(() => EligibilityRulesDto)
  eligibilityRules?: EligibilityRulesDto;
}

// ─── ADMIN: UPDATE POOL (only DRAFT pools) ──────────────────────
export class UpdateJackpotPoolDto {
  @IsOptional() @IsString() @Length(3, 150) nameEn?: string;
  @IsOptional() @IsString() @Length(0, 150) nameBn?: string;
  @IsOptional() @IsString() @Length(0, 2000) descriptionEn?: string;
  @IsOptional() @IsString() @Length(0, 2000) descriptionBn?: string;
  @IsOptional() @IsString() bannerUrl?: string;
  @IsOptional() @IsNumber() @Min(1) prizeAmount?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string;

  @IsOptional() @IsObject()
  @ValidateNested() @Type(() => EligibilityRulesDto)
  eligibilityRules?: EligibilityRulesDto;
}

// ─── ADMIN: ADJUST PRIZE MID-EVENT ──────────────────────────────
export class AdjustPrizeDto {
  /** Signed delta. Positive = add, negative = reduce. */
  @IsNumber()
  delta: number;

  @IsString() @Length(3, 500)
  reason: string;
}

// ─── ADMIN: PICK WINNER ─────────────────────────────────────────
export class PickWinnerDto {
  @IsInt()
  userId: number;

  @IsString() @Length(3, 1000)
  reason: string;          // for audit log + transparency
}

// ─── ADMIN: LIST QUERY ──────────────────────────────────────────
export class ListJackpotPoolsQueryDto {
  @IsOptional() @IsIn(JACKPOT_STATUSES)
  status?: JackpotStatus;

  @IsOptional() @IsString()
  currency?: string;

  @IsOptional() @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @IsInt() @Min(1) @Max(200)
  limit?: number = 20;
}