// src/turnover/dto/turnover.dto.ts
import {
  IsNumber,
  IsOptional,
  IsString,
  IsIn,
  Min,
  Length,
} from 'class-validator';

/**
 * Admin adjusts progress on an existing requirement.
 * amount is signed: +500 to add progress, -200 to remove.
 *
 *   POST /turnover/admin/adjust
 *   body: { requirementId: 7, amount: 500, reason: "Compensation for outage" }
 */
export class AdminAdjustTurnoverDto {
  @IsNumber()
  requirementId: number = 0;

  @IsNumber()
  amount: number = 0;

  @IsString()
  @Length(3, 500)
  reason: string = '';
}

/**
 * Admin cancels an active requirement (e.g. user got a refund).
 *
 *   POST /turnover/admin/cancel
 *   body: { requirementId: 7, reason: "Promo voided per user request" }
 */
export class AdminCancelTurnoverDto {
  @IsNumber()
  requirementId: number = 0;

  @IsString()
  @Length(3, 500)
  reason: string = '';
}

/**
 * Admin creates a manual requirement out-of-band.
 *   - For comping a player after a bug
 *   - For attaching rollover to an offline bonus
 *   - sourceType defaults to 'MANUAL' if not provided
 *   - multiplier defaults to 1.0 if not provided
 *
 *   POST /turnover/admin/create-manual
 *   body: { userId: 42, baseAmount: 1000, multiplier: 3, reason: "Welcome bonus" }
 */
export class AdminCreateTurnoverDto {
  @IsNumber()
  userId: number = 0;

  @IsNumber()
  @Min(1)
  baseAmount!: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  multiplier?: number;

  @IsOptional()
  @IsIn(['DEPOSIT', 'PROMOTION', 'MANUAL', 'BONUS'])
  sourceType?: 'DEPOSIT' | 'PROMOTION' | 'MANUAL' | 'BONUS';

  @IsString()
  @Length(3, 500)
  reason: string = '';
}

/**
 * Query string for admin list endpoint.
 *
 *   GET /turnover/admin/user/42?status=ACTIVE
 */
export class ListUserRequirementsQueryDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'COMPLETED', 'ARCHIVED', 'CANCELLED'])
  status?: 'ACTIVE' | 'COMPLETED' | 'ARCHIVED' | 'CANCELLED';
}