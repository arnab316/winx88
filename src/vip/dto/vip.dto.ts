
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsBoolean,
  IsInt,
  IsIn,
  IsArray,
  ValidateNested,
  ArrayMaxSize,
  Min,
  Length,
  IsObject,
} from 'class-validator';

export class UpdateVipLevelConfigDto {
  // ── Tier identity ──
  @IsOptional()
  @IsString()
  @Length(1, 80)
  levelName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  groupName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  coinsRequired?: number;

  @IsOptional()
  @IsString()
  badgeIconUrl?: string;

  @IsOptional()
  @IsObject()
  benefits?: Record<string, any>;

  // ── Presentation / status ──
  @IsOptional() @IsString() @Length(0, 20) uiColor?: string;
  @IsOptional() @IsInt() @Min(0) sequence?: number;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
  @IsOptional() @IsString() @Length(2, 10) currency?: string;
  @IsOptional() @IsBoolean() invitationOnly?: boolean;

  // ── Banking-side limits ──
  @IsOptional() @IsNumber() @Min(0) depositMin?: number;
  @IsOptional() @IsNumber() @Min(0) depositMax?: number;
  @IsOptional() @IsNumber() @Min(0) balanceBelow?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMin?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMax?: number;
  @IsOptional() @IsInt() @Min(0) withdrawalDailyCount?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalDailyMax?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalTurnover?: number;
  @IsOptional() @IsBoolean() allowClearBalance?: boolean;
  @IsOptional() @IsBoolean() autoClearTurnover?: boolean;
  @IsOptional() @IsString() @Length(0, 2000) internalRemark?: string;
}

export class CreateVipLevelConfigDto {
  // The numeric tier key (PK). Must be unique. 0 = lowest.
  @IsInt()
  @Min(0)
  level!: number;

  @IsString()
  @Length(1, 80)
  levelName!: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  groupName?: string;

  // Points threshold for AUTOMATIC promotion. Required unless invitationOnly.
  // For invitation-only tiers it is ignored and stored as an unreachable sentinel.
  @IsOptional()
  @IsNumber()
  @Min(0)
  coinsRequired?: number;

  @IsOptional()
  @IsBoolean()
  invitationOnly?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sequence?: number;

  @IsOptional()
  @IsString()
  @Length(0, 20)
  uiColor?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: string;

  @IsOptional()
  @IsString()
  @Length(2, 10)
  currency?: string;

  @IsOptional()
  @IsString()
  badgeIconUrl?: string;

  @IsOptional()
  @IsObject()
  benefits?: Record<string, any>;
}

export class AdminSetVipLevelDto {
  @IsNumber()
  userId: number;

  @IsNumber()
  @Min(0)
  level: number;

  @IsString()
  @Length(3, 500)
  reason: string;
}

// ─── TIER: banking-side limits (Member Group screen) ────────────
export class UpdateTierLimitsDto {
  @IsOptional() @IsNumber() @Min(0) depositMin?: number;
  @IsOptional() @IsNumber() @Min(0) depositMax?: number;
  @IsOptional() @IsNumber() @Min(0) balanceBelow?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMin?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMax?: number;
  @IsOptional() @IsInt() @Min(0) withdrawalDailyCount?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalDailyMax?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalTurnover?: number;
  @IsOptional() @IsBoolean() allowClearBalance?: boolean;
  @IsOptional() @IsBoolean() autoClearTurnover?: boolean;
  @IsOptional() @IsString() @Length(0, 2000) internalRemark?: string;
  @IsOptional() @IsBoolean() invitationOnly?: boolean;
  @IsOptional() @IsString() @Length(0, 20) uiColor?: string;
  @IsOptional() @IsInt() @Min(0) sequence?: number;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
  @IsOptional() @IsString() @Length(2, 10) currency?: string;
}

// ─── MEMBER GROUP: create a new tier (every settable column) ────────────
export class CreateMemberGroupDto {
  @IsInt() @Min(0) level!: number;          // numeric tier key (PK), unique
  @IsString() @Length(1, 80) name!: string; // level_name
  @IsOptional() @IsString() @Length(1, 80) groupName?: string;
  // Points threshold for auto-promotion. Required unless invitationOnly.
  @IsOptional() @IsNumber() @Min(0) coinsRequired?: number;
  @IsOptional() @IsBoolean() invitationOnly?: boolean;
  @IsOptional() @IsString() @Length(2, 10) currency?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
  @IsOptional() @IsInt() @Min(0) sequence?: number;
  @IsOptional() @IsString() @Length(0, 20) uiColor?: string;
  @IsOptional() @IsString() badgeIconUrl?: string;
  @IsOptional() @IsObject() benefits?: Record<string, any>;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  // ── banking-side limits ──
  @IsOptional() @IsNumber() @Min(0) depositMin?: number;
  @IsOptional() @IsNumber() @Min(0) depositMax?: number;
  @IsOptional() @IsNumber() @Min(0) balanceBelow?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMin?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMax?: number;
  @IsOptional() @IsInt() @Min(0) withdrawalDailyCount?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalDailyMax?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalTurnover?: number;
  @IsOptional() @IsBoolean() allowClearBalance?: boolean;
  @IsOptional() @IsBoolean() autoClearTurnover?: boolean;
  @IsOptional() @IsString() @Length(0, 2000) internalRemark?: string;
}

// ─── MEMBER GROUP: unified edit (the "Action" pencil on the list) ───────
//   One call to edit any settable column. All fields optional.
export class UpdateMemberGroupDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string; // level_name
  @IsOptional() @IsString() @Length(1, 80) groupName?: string;
  @IsOptional() @IsNumber() @Min(0) coinsRequired?: number;
  @IsOptional() @IsBoolean() invitationOnly?: boolean;
  @IsOptional() @IsString() @Length(2, 10) currency?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: string;
  @IsOptional() @IsInt() @Min(0) sequence?: number;
  @IsOptional() @IsString() @Length(0, 20) uiColor?: string;
  @IsOptional() @IsString() badgeIconUrl?: string;
  @IsOptional() @IsObject() benefits?: Record<string, any>;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  // ── banking-side limits ──
  @IsOptional() @IsNumber() @Min(0) depositMin?: number;
  @IsOptional() @IsNumber() @Min(0) depositMax?: number;
  @IsOptional() @IsNumber() @Min(0) balanceBelow?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMin?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalMax?: number;
  @IsOptional() @IsInt() @Min(0) withdrawalDailyCount?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalDailyMax?: number;
  @IsOptional() @IsNumber() @Min(0) withdrawalTurnover?: number;
  @IsOptional() @IsBoolean() allowClearBalance?: boolean;
  @IsOptional() @IsBoolean() autoClearTurnover?: boolean;
  @IsOptional() @IsString() @Length(0, 2000) internalRemark?: string;
}

// ─── TIER: allowed payment channels ─────────────────────────────
export class TierBankChannelDto {
  @IsString() @Length(1, 30) channel!: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

export class SetTierBanksDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TierBankChannelDto)
  channels!: TierBankChannelDto[];
}