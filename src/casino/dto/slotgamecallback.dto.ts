import { IsNotEmpty } from 'class-validator';

export class SlotGameCallbackDataDTO {
  @IsNotEmpty()
  account: string;

  trans_guid: string;

  round_id: string;

  provider_id: string;

  game_code: string;

  game_type: string;

  amount: number;

  type: number;

  match_id: number;
}

export class SlotGameCallbackDTO {
  @IsNotEmpty()
  command: string;

  @IsNotEmpty()
  data: SlotGameCallbackDataDTO;

  @IsNotEmpty()
  timestamp: string;

  @IsNotEmpty()
  check: string;
}
