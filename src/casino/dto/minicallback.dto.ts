import { IsNotEmpty, IsNumber, IsString } from 'class-validator';

export class GetMiniBalanceDTO {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @IsString()
  @IsNotEmpty()
  sign: string;
}

export class MiniBetWinDTO {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @IsString()
  @IsNotEmpty()
  gameCode: string;

  @IsNumber()
  @IsNotEmpty()
  betAmount: number;

  @IsNumber()
  @IsNotEmpty()
  winAmount: number;

  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @IsString()
  @IsNotEmpty()
  sign: string;
}

export class MiniWithdrawDTO {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @IsString()
  @IsNotEmpty()
  gameCode: string;

  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @IsString()
  @IsNotEmpty()
  sign: string;
}

export class MiniDepositDTO {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  partnerLoginId: string;

  @IsString()
  @IsNotEmpty()
  gameCode: string;

  @IsNumber()
  @IsNotEmpty()
  amount: number;

  @IsString()
  @IsNotEmpty()
  transactionId: string;

  @IsString()
  @IsNotEmpty()
  sign: string;
}
