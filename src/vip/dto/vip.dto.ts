
import {
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Length,
  IsObject,
} from 'class-validator';

export class UpdateVipLevelConfigDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  levelName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  groupName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  coinsRequired?: number;

  @IsOptional()
  @IsString()
  badgeIconUrl?: string;

  @IsOptional()
  @IsObject()
  benefits?: Record<string, any>;
}

export class AdminSetVipLevelDto {
  @IsNumber()
  userId: number;

  @IsNumber()
  @Min(0)
  level: number;

  @IsString()
  @Length(3, 500)
  reason: string;
}