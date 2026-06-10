import { Expose, Type } from 'class-transformer';
import { IsArray, IsNotEmpty, ValidateNested } from 'class-validator';

export class SportsCallbackDataDTO {
  @IsNotEmpty()
  userName: string;

  amount: number;

  @Expose({ name: 'betList' })
  @Type(() => SportsbetList)
  @IsArray()
  @ValidateNested({ each: true })
  betList: SportsbetList[];

  trans_id: string;

  trans_hist_id: string;

  type: number;

  dateTime: string;
}

export class SportsbetList {
  @IsNotEmpty()
  id: string;

  type: number;
  status: number;
  unitStake: number;
  totalStake: number;
  finalStake: number;
  openStake: number;
  totalWin: number;
  openPotWin: number;
  combLength: number;
  linesCount: number;
  createdDate: string;
  currency: string;
  remainingTotalWin: number;
  cashOutValue: number;
  partialCashOut: number;
  partialCashOutValues: string;
  bonus: number;
  bonusPart: number;
  initBonusPart: number;
  bonusPartPercent: number;
  bonusInsurance: number;
  isCancelAllowed: boolean;
  totalOdds: number;
  device: number;
  
  @Expose({ name: 'selections' })
  @Type(() => Selection)
  @IsArray()
  @ValidateNested({ each: true })
  selections: Selection[];
}

export class Selection {
  @IsNotEmpty()
  id: string;
  status: number;
  price: number;
  priceType: number;
  name: string;
  spec: string;
  marketName: string;
  marketTypeId: number;
  isLive: boolean;
  isBetBuilder: boolean;
  isBanker: boolean;
  isVirtual: boolean;
  eventId: number;
  eventName: string;
  eventDate: Date;
  isLiveOrVirtual: boolean;
  sportTypeId: number;
  sportId: number;
  champId: number;
  catId: number;
  marketId: number;
  selectionTypeId: number;
  eventScore: string;
  gameTime: string;

  @Expose({ name: 'bbOdds' })
  @Type(() => BetBuilderResponseODDa)
  @IsArray()
  @ValidateNested({ each: true })
  bbOdds: BetBuilderResponseODDa[];
}

export class BetBuilderResponseODDa {
  marketName: string;
  oddName: string;
  status: number;
  id: number;
  marketId: number;
  selectionTypeId: number;
  sportMarketId: number;
  marketTypeId: number;
}

export class SportsCallbackDTO {
  @IsNotEmpty()
  command: string;

  @IsNotEmpty()
  data: SportsCallbackDataDTO;

  @IsNotEmpty()
  key: string;
}
