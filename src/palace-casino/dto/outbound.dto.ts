export class GameListDto {
  provider_id!: number;
  lang?: number;
}

export class LaunchGameDto {
  provider_id!: number;
  game_symbol!: string;
  return_url!: string;
  lang?: number;
  win_ratio?: number;
}

export class TransferDto {
  amount!: number;
}
