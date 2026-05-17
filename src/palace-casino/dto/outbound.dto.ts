import { IsNotEmpty, IsNumber, IsOptional, IsString } from "class-validator";

export class GameListDto {
  provider_id!: number;
  lang?: number;
}

export class LaunchGameDto {
  @IsNotEmpty()
  @IsNumber()
  provider_id!: number;

  @IsNotEmpty()
  @IsString()
  game_symbol!: string;

  @IsNotEmpty()
  @IsString()
  return_url!: string;

  @IsOptional()
  @IsNumber()
  lang?: number;

  @IsOptional()
  @IsNumber()
  win_ratio?: number;
}

export class TransferDto {
  amount!: number;
}
