import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class SlotGameCallbackDataDTO {
  @ApiProperty({ example: 'testuser', description: 'The unique player username' })
  @IsNotEmpty()
  account: string;

  @ApiProperty({ example: 'tx-slot-9922', description: 'Unique transaction GUID' })
  trans_guid: string;

  @ApiProperty({ example: 'round-abc-123', description: 'Unique round ID' })
  round_id: string;

  @ApiProperty({ example: 'jili', description: 'Provider ID' })
  provider_id: string;

  @ApiProperty({ example: 'game-12', description: 'Game code' })
  game_code: string;

  @ApiProperty({ example: 'slots', description: 'Game type' })
  game_type: string;

  @ApiProperty({ example: 10.00, description: 'Transaction amount' })
  amount: number;

  @ApiProperty({ example: 1, description: 'Type identifier' })
  type: number;

  @ApiProperty({ example: 0, description: 'Match ID' })
  match_id: number;
}

export class SlotGameCallbackDTO {
  @ApiProperty({ example: 'bet', description: 'The command to execute (e.g. authenticate, balance, bet, win, cancel, status)' })
  @IsNotEmpty()
  command: string;

  @ApiProperty({ type: SlotGameCallbackDataDTO, description: 'Transaction data details' })
  @IsNotEmpty()
  data: SlotGameCallbackDataDTO;

  @ApiProperty({ example: '1780000000', description: 'Timestamp' })
  @IsNotEmpty()
  timestamp: string;

  @ApiProperty({ example: '21,22,31,41', description: 'Validation checks required (comma-separated list of numeric check codes)' })
  @IsNotEmpty()
  check: string;
}
