import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsArray, IsNotEmpty, IsOptional, ValidateNested } from 'class-validator';

export class BetBuilderResponseODDa {
  @ApiProperty({ example: 'Total Goals Over/Under' })
  marketName: string;

  @ApiProperty({ example: 'Over 2.5' })
  oddName: string;

  @ApiProperty({ example: 1 })
  status: number;

  @ApiProperty({ example: 1002 })
  id: number;

  @ApiProperty({ example: 55 })
  marketId: number;

  @ApiProperty({ example: 2 })
  selectionTypeId: number;

  @ApiProperty({ example: 99 })
  sportMarketId: number;

  @ApiProperty({ example: 10 })
  marketTypeId: number;
}

export class Selection {
  // Provider's documented selection payload has no "id" field — must stay optional
  @ApiProperty({ example: 'sel-9988', required: false })
  @IsOptional()
  id?: string;

  @ApiProperty({ example: 1 })
  status: number;

  @ApiProperty({ example: 1.85 })
  price: number;

  @ApiProperty({ example: 1 })
  priceType: number;

  @ApiProperty({ example: 'Over 2.5 Goals' })
  name: string;

  @ApiProperty({ example: 'spec-val' })
  spec: string;

  @ApiProperty({ example: 'Over/Under' })
  marketName: string;

  @ApiProperty({ example: 3 })
  marketTypeId: number;

  @ApiProperty({ example: true })
  isLive: boolean;

  @ApiProperty({ example: false })
  isBetBuilder: boolean;

  @ApiProperty({ example: false })
  isBanker: boolean;

  @ApiProperty({ example: false })
  isVirtual: boolean;

  @ApiProperty({ example: 12345 })
  eventId: number;

  @ApiProperty({ example: 'Real Madrid vs Barcelona' })
  eventName: string;

  @ApiProperty({ example: '2026-06-10T22:00:00Z' })
  eventDate: Date;

  @ApiProperty({ example: true })
  isLiveOrVirtual: boolean;

  @ApiProperty({ example: 1 })
  sportTypeId: number;

  @ApiProperty({ example: 1 })
  sportId: number;

  @ApiProperty({ example: 12 })
  champId: number;

  @ApiProperty({ example: 5 })
  catId: number;

  @ApiProperty({ example: 33 })
  marketId: number;

  @ApiProperty({ example: 2 })
  selectionTypeId: number;

  @ApiProperty({ example: '2-1' })
  eventScore: string;

  @ApiProperty({ example: '75 min' })
  gameTime: string;

  @ApiProperty({ type: [BetBuilderResponseODDa], required: false })
  @Expose({ name: 'bbOdds' })
  @Type(() => BetBuilderResponseODDa)
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  bbOdds?: BetBuilderResponseODDa[];
}

export class SportsbetList {
  @ApiProperty({ example: 'bet-5544' })
  @IsOptional()
  id?: string;

  @ApiProperty({ example: 1 })
  type: number;

  @ApiProperty({ example: 0 })
  status: number;

  @ApiProperty({ example: 10.00 })
  unitStake: number;

  @ApiProperty({ example: 10.00 })
  totalStake: number;

  @ApiProperty({ example: 10.00 })
  finalStake: number;

  @ApiProperty({ example: 10.00 })
  openStake: number;

  @ApiProperty({ example: 18.50 })
  totalWin: number;

  @ApiProperty({ example: 18.50 })
  openPotWin: number;

  @ApiProperty({ example: 1 })
  combLength: number;

  @ApiProperty({ example: 1 })
  linesCount: number;

  @ApiProperty({ example: '2026-06-10T16:21:00Z' })
  createdDate: string;

  @ApiProperty({ example: 'BDT' })
  currency: string;

  @ApiProperty({ example: 18.50 })
  remainingTotalWin: number;

  @ApiProperty({ example: 0 })
  cashOutValue: number;

  @ApiProperty({ example: 0 })
  partialCashOut: number;

  @ApiProperty({ example: '' })
  partialCashOutValues: string;

  @ApiProperty({ example: 0 })
  bonus: number;

  @ApiProperty({ example: 0 })
  bonusPart: number;

  @ApiProperty({ example: 0 })
  initBonusPart: number;

  @ApiProperty({ example: 0 })
  bonusPartPercent: number;

  @ApiProperty({ example: 0 })
  bonusInsurance: number;

  @ApiProperty({ example: true })
  isCancelAllowed: boolean;

  @ApiProperty({ example: 1.85 })
  totalOdds: number;

  @ApiProperty({ example: 1 })
  device: number;

  @ApiProperty({ type: [Selection], required: false })
  @Expose({ name: 'selections' })
  @Type(() => Selection)
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  selections?: Selection[];
}

export class SportsCallbackDataDTO {
  // Provider payloads are inconsistent: getBalance docs use "userName",
  // bet/win examples use "username". Accept both; the service normalizes.
  @ApiProperty({ example: 'testuser', description: 'The unique player username', required: false })
  @IsOptional()
  userName?: string;

  @ApiProperty({ example: 'testuser', description: 'Alternate casing some callbacks use', required: false })
  @IsOptional()
  username?: string;

  @ApiProperty({ example: 10.00, description: 'Callback transaction amount', required: false })
  @IsOptional()
  amount?: number;

  // Absent on getBalance callbacks
  @ApiProperty({ type: [SportsbetList], description: 'List of bets placed', required: false })
  @Expose({ name: 'betList' })
  @Type(() => SportsbetList)
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  betList?: SportsbetList[];

  // Only sent on win callbacks (equals the bet item id from the bet callback)
  @ApiProperty({ example: 'tx-sports-5544', description: 'Unique transaction ID', required: false })
  @IsOptional()
  trans_id?: string;

  @ApiProperty({ example: 'hist-sports-1122', description: 'Unique transaction history ID', required: false })
  @IsOptional()
  trans_hist_id?: string;

  @ApiProperty({ example: 1, description: 'Type identifier', required: false })
  @IsOptional()
  type?: number;

  @ApiProperty({ example: '2026-06-10T16:21:00Z', description: 'Callback date time', required: false })
  @IsOptional()
  dateTime?: string;
}

export class SportsCallbackDTO {
  @ApiProperty({ example: 'bet', description: 'The command to execute (e.g. getBalance, bet, win)' })
  @IsNotEmpty()
  command: string;

  @ApiProperty({ type: SportsCallbackDataDTO, description: 'Sports callback data' })
  @IsNotEmpty()
  @Type(() => SportsCallbackDataDTO)
  @ValidateNested()
  data: SportsCallbackDataDTO;

  // Not part of the provider's documented callback body — keep optional
  @ApiProperty({ example: 'sports-secret-key-12345', description: 'Sports validation key/token', required: false })
  @IsOptional()
  key?: string;
}
