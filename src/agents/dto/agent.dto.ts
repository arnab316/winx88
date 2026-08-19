// src/agent/dto/agent.dto.ts
import {
  IsString,
  IsOptional,
  IsIn,
  IsInt,
  IsDateString,
  Length,
  Matches,
  IsNumber,
  Min,
} from 'class-validator';

export class CreateAgentDto {
  @IsInt()
  gatewayId: number;

  // 'QR' = a scannable merchant poster rather than a number to type in.
  @IsIn(['bKash', 'Nagad', 'Rocket', 'Bank', 'Crypto', 'QR'])
  walletType: string;

  @IsString()
  @Length(6, 30)
  @Matches(/^[0-9+\-\s]+$/, { message: 'agentNumber must contain digits only' })
  agentNumber: string;

  @IsOptional()
  @IsString()
  @Length(1, 30)
  agentCode?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string; // YYYY-MM-DD

  @IsOptional()
  @IsDateString()
  stopDate?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  // S3 URL of the merchant QR poster, from POST /agents/admin/qr-image.
  // REQUIRED when walletType is 'QR' — without it the player gets a deposit
  // screen with nothing to scan.
  @IsOptional()
  @IsString()
  @Length(1, 500)
  qrImageUrl?: string;
}

export class UpdateAgentDto {
  @IsOptional()
  @IsInt()
  gatewayId?: number;

  @IsOptional()
  // 'QR' = a scannable merchant poster rather than a number to type in.
  @IsIn(['bKash', 'Nagad', 'Rocket', 'Bank', 'Crypto', 'QR'])
  walletType?: string;

  @IsOptional()
  @IsString()
  @Length(6, 30)
  @Matches(/^[0-9+\-\s]+$/)
  agentNumber?: string;

  @IsOptional()
  @IsString()
  agentCode?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  stopDate?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  // Empty string clears the poster (and turns a QR destination back into a
  // plain wallet agent).
  @IsOptional()
  @IsString()
  @Length(0, 500)
  qrImageUrl?: string;
}

export class ListAgentsQueryDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @IsOptional()
  @IsInt()
  gatewayId?: number;

  @IsOptional()
  // 'QR' = a scannable merchant poster rather than a number to type in.
  @IsIn(['bKash', 'Nagad', 'Rocket', 'Bank', 'Crypto', 'QR'])
  walletType?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

// For the user-facing "give me an agent for deposit" call
export class GetDepositAgentQueryDto {
  @IsInt()
  gatewayId: number;
}