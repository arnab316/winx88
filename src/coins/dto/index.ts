// src/coin/dto/coin.dto.ts
import { IsNumber, IsOptional, IsString, IsBoolean, Min, Length } from 'class-validator';

export class UpdateCoinSettingsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  coinsPerUnit?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  depositUnit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minDepositAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDepositAmount?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AdminAdjustCoinsDto {
  @IsNumber()
  userId: number;

  /** Signed: +100 to credit, -50 to debit */
  @IsNumber()
  amount: number;

  @IsString()
  @Length(3, 500)
  reason: string;
}