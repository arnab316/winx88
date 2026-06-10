import { IsNotEmpty, IsOptional } from 'class-validator';

export class OroPlayBalanceDTO {
  @IsNotEmpty()
  userCode: string;
}

export class OroPlayTransactionDTO {
  @IsNotEmpty()
  userCode: string;

  @IsNotEmpty()
  vendorCode: string;

  @IsNotEmpty()
  gameCode: string;

  @IsNotEmpty()
  historyId: number;

  @IsNotEmpty()
  roundId: string;

  @IsNotEmpty()
  gameType: number; // 1: Casino, 2: Slot, 3: Other, 4: Fishing

  @IsNotEmpty()
  transactionCode: string;

  @IsNotEmpty()
  isFinished: boolean;

  @IsNotEmpty()
  isCanceled: boolean;

  @IsNotEmpty()
  amount: number; // negative = bet, positive = win

  @IsOptional()
  detail: string;

  @IsOptional()
  createdAt: string;
}

export class OroPlayBatchTransactionsDTO {
  @IsNotEmpty()
  userCode: string;

  @IsNotEmpty()
  transactions: OroPlayTransactionDTO[];
}
