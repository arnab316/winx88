import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import { toInt } from 'src/common/dto-transforms';

/**
 * Paging shared by every history endpoint.
 *
 * `limit` is capped at 100 in the DTO rather than only in SQL: an agent asking
 * for 10,000 rows should be told no, not quietly served 100.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export const DEPOSIT_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export const WITHDRAWAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export class DepositQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DEPOSIT_STATUSES })
  @IsOptional()
  @IsIn(DEPOSIT_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({
    description:
      'The transaction id the customer entered when sending the money ' +
      '(bKash/Nagad/Rocket TRX). Matched case-insensitively, trimmed.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  transactionNumber?: string;
}

export class WithdrawalQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WITHDRAWAL_STATUSES })
  @IsOptional()
  @IsIn(WITHDRAWAL_STATUSES as unknown as string[])
  status?: string;
}

export const BET_STATUSES = ['WON', 'LOST', 'PLACED', 'CANCELLED'] as const;
export const BET_CATEGORIES = [
  'LOTTERY', 'JACKPOT', 'SLOT', 'LIVE', 'FISHING', 'CRASH', 'POKER', 'SPORTS',
] as const;

export class BetQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: BET_STATUSES })
  @IsOptional()
  @IsIn(BET_STATUSES as unknown as string[])
  status?: string;

  @ApiPropertyOptional({ enum: BET_CATEGORIES })
  @IsOptional()
  @IsIn(BET_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive' })
  @IsOptional()
  @IsString()
  to?: string;
}

export class TransactionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'Comma-separated ledger groups, e.g. DEPOSIT,WITHDRAWAL',
  })
  @IsOptional()
  @IsString()
  type?: string;
}
