// src/spin/dto/spin.dto.ts
import { Type, Transform } from 'class-transformer';
import {
  IsString, IsOptional, IsBoolean, IsInt, IsIn, IsNumber,
  IsArray, IsDateString, Min, Max, Length, ValidateNested,
  ArrayMinSize, ArrayMaxSize, Matches,
} from 'class-validator';

export const SPIN_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type SpinFrequency = (typeof SPIN_FREQUENCIES)[number];

export const SPIN_BONUS_DESTINATIONS = ['BONUS_BALANCE', 'MAIN_BALANCE'] as const;
export type SpinBonusDestination = (typeof SPIN_BONUS_DESTINATIONS)[number];

/**
 * Slice counts a wheel may have. Even numbers only — an odd count puts the
 * pointer on a slice EDGE at the 12 o'clock rest position on most renderers.
 *
 * NOTE: the player-facing wheel component must be able to draw the count you
 * pick here. This list previously read [4, 6] because that was all the client
 * could render; confirm the renderer handles 8/10/12 before enabling one.
 */
export const SPIN_SEGMENT_COUNTS = [4, 6, 8, 10, 12] as const;

/** Largest allowed slice count — the single source for the position bound. */
export const SPIN_MAX_SEGMENTS = Math.max(...SPIN_SEGMENT_COUNTS);

const toBool = ({ value }: { value: any }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

const toUpperEnum = ({ value }: { value: any }) => {
  if (value === '' || value === null || value === undefined) return undefined;
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
};

const emptyToUndefined = ({ value }: { value: any }) =>
  value === '' || value === null ? undefined : value;

// ─── ONE SLICE ──────────────────────────────────────────────────
export class SpinSegmentDto {
  /** 0-based, clockwise from the top. Must cover 0..segmentCount-1 exactly once. */
  // Bounded by the LARGEST permitted wheel. The exact per-wheel bound cannot be
  // enforced here — a slice DTO cannot see its parent's segmentCount — so
  // SpinService.assertSegments does that check against the real count.
  @IsInt() @Min(0) @Max(SPIN_MAX_SEGMENTS - 1)
  position!: number;

  @IsOptional() @IsString() @Length(0, 80)
  label?: string;

  /** The prize in real money. 0 is valid — a wheel needs losing slices. */
  @IsNumber() @Min(0)
  amount!: number;

  /**
   * Turnover this slice carries. The requirement raised is
   * `amount x turnoverMultiplier`; 0 means the prize is withdrawable at once.
   */
  @IsOptional() @IsNumber() @Min(0)
  turnoverMultiplier?: number;

  /**
   * Relative odds. Never sent to the player. Equal weights give a fair wheel;
   * weight 0 takes the slice out of the draw while leaving it on screen.
   */
  @IsOptional() @IsInt() @Min(0)
  weight?: number;

  @IsOptional() @IsString() @Length(0, 20)
  color?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

// ─── ADMIN: CREATE WHEEL ────────────────────────────────────────
export class CreateSpinWheelDto {
  @IsString() @Length(2, 120)
  name!: string;

  @IsOptional() @IsString() @Length(2, 10)
  currency?: string;

  @IsOptional() @IsInt() @IsIn(SPIN_SEGMENT_COUNTS as unknown as number[])
  segmentCount?: number;

  // ── schedule ──
  @IsOptional() @Transform(toUpperEnum) @IsIn(SPIN_FREQUENCIES)
  frequency?: SpinFrequency;

  /** 0 = Sunday … 6 = Saturday. Required for WEEKLY. */
  @IsOptional() @IsInt() @Min(0) @Max(6)
  dayOfWeek?: number;

  /** 1–28 — capped so a monthly wheel exists in February too. */
  @IsOptional() @IsInt() @Min(1) @Max(28)
  dayOfMonth?: number;

  /** Local wall-clock time the window opens, `HH:MM` or `HH:MM:SS`. */
  @IsOptional() @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'startTime must be HH:MM or HH:MM:SS (24h)',
  })
  startTime?: string;

  /** How long the window stays open. Omit to leave it open for the whole period. */
  @IsOptional() @IsInt() @Min(1)
  windowMinutes?: number;

  /** IANA name, e.g. `Asia/Dhaka`. The schedule is read in this zone. */
  @IsOptional() @IsString() @Length(2, 64)
  timezone?: string;

  @IsOptional() @IsInt() @Min(1) @Max(100)
  spinsPerWindow?: number;

  @IsOptional() @Transform(toUpperEnum) @IsIn(SPIN_BONUS_DESTINATIONS)
  bonusTo?: SpinBonusDestination;

  // ── who may spin ──
  @IsOptional() @IsInt() @Min(0)
  minVipLevel?: number;

  @IsOptional() @IsInt()
  memberGroupId?: number;

  /** Player must have deposited at least this much inside the window. */
  @IsOptional() @IsNumber() @Min(0)
  minDepositInWindow?: number;

  // ── campaign life ──
  @IsOptional() @Transform(emptyToUndefined) @IsDateString()
  startsAt?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsDateString()
  endsAt?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  /**
   * The slices. Optional on create — a wheel can be saved as a draft and have
   * its segments set later — but the wheel will not go live until it has
   * exactly `segmentCount` of them.
   */
  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => SpinSegmentDto)
  @ArrayMinSize(Math.min(...SPIN_SEGMENT_COUNTS)) @ArrayMaxSize(SPIN_MAX_SEGMENTS)
  segments?: SpinSegmentDto[];
}

// ─── ADMIN: UPDATE (all optional) ───────────────────────────────
// Standalone rather than `extends CreateSpinWheelDto`, matching
// UpdatePromotionDto: `name` is required on create, and a subclass cannot
// relax a required property to optional.
export class UpdateSpinWheelDto {
  @IsOptional() @IsString() @Length(2, 120) name?: string;
  @IsOptional() @IsString() @Length(2, 10) currency?: string;

  @IsOptional() @IsInt() @IsIn(SPIN_SEGMENT_COUNTS as unknown as number[])
  segmentCount?: number;

  @IsOptional() @Transform(toUpperEnum) @IsIn(SPIN_FREQUENCIES)
  frequency?: SpinFrequency;

  @IsOptional() @IsInt() @Min(0) @Max(6) dayOfWeek?: number;
  @IsOptional() @IsInt() @Min(1) @Max(28) dayOfMonth?: number;

  @IsOptional() @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, {
    message: 'startTime must be HH:MM or HH:MM:SS (24h)',
  })
  startTime?: string;

  @IsOptional() @IsInt() @Min(1) windowMinutes?: number;
  @IsOptional() @IsString() @Length(2, 64) timezone?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) spinsPerWindow?: number;

  @IsOptional() @Transform(toUpperEnum) @IsIn(SPIN_BONUS_DESTINATIONS)
  bonusTo?: SpinBonusDestination;

  @IsOptional() @IsInt() @Min(0) minVipLevel?: number;
  @IsOptional() @IsInt() memberGroupId?: number;
  @IsOptional() @IsNumber() @Min(0) minDepositInWindow?: number;

  @IsOptional() @Transform(emptyToUndefined) @IsDateString() startsAt?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsDateString() endsAt?: string;

  @IsOptional() @IsBoolean() isActive?: boolean;

  @IsOptional() @IsArray() @ValidateNested({ each: true })
  @Type(() => SpinSegmentDto)
  @ArrayMinSize(Math.min(...SPIN_SEGMENT_COUNTS)) @ArrayMaxSize(SPIN_MAX_SEGMENTS)
  segments?: SpinSegmentDto[];
}

// ─── ADMIN: REPLACE SEGMENTS ────────────────────────────────────
export class ReplaceSegmentsDto {
  @IsArray() @ValidateNested({ each: true })
  @Type(() => SpinSegmentDto)
  @ArrayMinSize(Math.min(...SPIN_SEGMENT_COUNTS)) @ArrayMaxSize(SPIN_MAX_SEGMENTS)
  segments!: SpinSegmentDto[];
}

// ─── ADMIN: LIST WHEELS ─────────────────────────────────────────
export class ListSpinWheelsQueryDto {
  @IsOptional() @IsString() currency?: string;

  @IsOptional() @Transform(toBool) @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsString() search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 20;
}

// ─── ADMIN: SPIN RESULTS ────────────────────────────────────────
export class ListSpinResultsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt()
  wheelId?: number;

  @IsOptional() @Type(() => Number) @IsInt()
  userId?: number;

  /** Username, phone or email. */
  @IsOptional() @IsString() search?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsDateString()
  from?: string;

  @IsOptional() @Transform(emptyToUndefined) @IsDateString()
  to?: string;

  /** `true` hides the zero-prize spins. */
  @IsOptional() @Transform(toBool) @IsBoolean()
  winsOnly?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 20;
}

// ─── PLAYER ─────────────────────────────────────────────────────
export class PlayerSpinQueryDto {
  @IsOptional() @IsString() @Length(2, 10)
  currency?: string;
}

export class MySpinHistoryQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;
}

/**
 * The spin request carries no prize information — the server picks the slice.
 * `wheelId` is optional; omitted, the live wheel for the player's currency is used.
 */
export class SpinNowDto {
  @IsOptional() @IsInt()
  wheelId?: number;

  @IsOptional() @IsString() @Length(2, 10)
  currency?: string;
}
