import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional } from 'class-validator';

export class OroPlayBalanceDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique player username on OroPlay' })
  @IsNotEmpty()
  userCode: string;
}

export class OroPlayTransactionDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique player username' })
  @IsNotEmpty()
  userCode: string;

  @ApiProperty({ example: 'evolution', description: 'Vendor code' })
  @IsNotEmpty()
  vendorCode: string;

  @ApiProperty({ example: 'lobby', description: 'Game code' })
  @IsNotEmpty()
  gameCode: string;

  @ApiProperty({ example: 987654, description: 'History transaction ID' })
  @IsNotEmpty()
  historyId: number;

  @ApiProperty({ example: 'round-112233', description: 'Unique round ID' })
  @IsNotEmpty()
  roundId: string;

  @ApiProperty({ example: 1, description: 'Game type ID (1: Casino, 2: Slot, 3: Other, 4: Fishing)' })
  @IsNotEmpty()
  gameType: number;

  @ApiProperty({ example: 'tx-oroplay-8877', description: 'Unique transaction code' })
  @IsNotEmpty()
  transactionCode: string;

  @ApiProperty({ example: true, description: 'Indicates if the round is finished' })
  @IsNotEmpty()
  isFinished: boolean;

  @ApiProperty({ example: false, description: 'Indicates if the transaction was canceled' })
  @IsNotEmpty()
  isCanceled: boolean;

  @ApiProperty({ example: -10.50, description: 'Transaction amount (negative value represents a bet/debit, positive represents a win/credit)' })
  @IsNotEmpty()
  amount: number;

  @ApiProperty({ example: 'Optional transaction details', required: false })
  @IsOptional()
  detail?: string;

  @ApiProperty({ example: '2026-06-10T16:21:00Z', required: false, description: 'Transaction timestamp' })
  @IsOptional()
  createdAt?: string;
}

export class OroPlayBatchTransactionsDTO {
  @ApiProperty({ example: 'testuser', description: 'The player username' })
  @IsNotEmpty()
  userCode: string;

  @ApiProperty({ type: [OroPlayTransactionDTO], description: 'List of transactions to process' })
  @IsNotEmpty()
  transactions: OroPlayTransactionDTO[];
}
