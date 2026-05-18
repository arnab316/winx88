import { IsNumber, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class GameListDto {
  @IsNumber()
  @Type(() => Number)
  provider_id!: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lang?: number;
}

export class LaunchGameDto {
  @IsNumber()
  @Type(() => Number)
  provider_id!: number;

  @IsString()
  @IsNotEmpty()
  game_symbol!: string;

  @IsString()
  @IsNotEmpty()
  return_url!: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  lang?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  win_ratio?: number;
}

export class TransferDto {
  @IsNumber()
  @Type(() => Number)
  amount!: number;
}