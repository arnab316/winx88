import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class GetMiniBalanceDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique username of the player' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'dark_bdt_login', description: 'Login ID of the partner' })
  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @ApiProperty({ example: 'abc123xyzsignature', description: 'Request signature for validation' })
  @IsString()
  @IsNotEmpty()
  sign: string;
}

export class MiniBetWinDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique username of the player' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'dark_bdt_login', description: 'Login ID of the partner' })
  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @ApiProperty({ example: 'bg25rouletteus', description: 'Game symbol identifier' })
  @IsString()
  @IsNotEmpty()
  gameCode: string;

  @ApiProperty({ example: 100.00, description: 'Amount placed on bet' })
  @IsNumber()
  @IsNotEmpty()
  betAmount: number;

  @ApiProperty({ example: 150.00, description: 'Amount won from game' })
  @IsNumber()
  @IsNotEmpty()
  winAmount: number;

  @ApiProperty({ example: 'tx-99882233', description: 'Unique transaction ID from mini-game provider' })
  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @ApiProperty({ example: 'sign12345', description: 'Request signature for validation' })
  @IsString()
  @IsNotEmpty()
  sign: string;
}

export class MiniWithdrawDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique username of the player' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'dark_bdt_login', description: 'Login ID of the partner' })
  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @ApiProperty({ example: 'bg25rouletteus', description: 'Game symbol identifier' })
  @IsString()
  @IsNotEmpty()
  gameCode: string;

  @ApiProperty({ example: 50.00, description: 'Withdrawal amount' })
  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @ApiProperty({ example: 'tx-88334411', description: 'Unique transaction ID' })
  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @ApiProperty({ example: 'sign54321', description: 'Request signature for validation' })
  @IsString()
  @IsNotEmpty()
  sign: string;
}

export class MiniDepositDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique username of the player' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'dark_bdt_login', description: 'Login ID of the partner' })
  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @ApiProperty({ example: 'bg25rouletteus', description: 'Game symbol identifier' })
  @IsString()
  @IsNotEmpty()
  gameCode: string;

  @ApiProperty({ example: 75.00, description: 'Deposit amount' })
  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @ApiProperty({ example: 'tx-22334455', description: 'Unique transaction ID' })
  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @ApiProperty({ example: 'sign67890', description: 'Request signature for validation' })
  @IsString()
  @IsNotEmpty()
  sign: string;
}
