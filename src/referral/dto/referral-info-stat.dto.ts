import { IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';

export class CreateReferralInfoStatDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  no_of_people: number;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  amount: number;
}

export class UpdateReferralInfoStatDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  no_of_people?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}
