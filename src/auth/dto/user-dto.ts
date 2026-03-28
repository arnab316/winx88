import { IsString, IsEmail, IsOptional, IsDateString, IsBoolean, IsNumber, IsIn, Min, MaxLength } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @MaxLength(30)
  user_code: string | undefined;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  full_name?: string;

  @IsString()
  @MaxLength(80)
  username: string | undefined;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @IsString()
  password: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsString()
  profile_image_url?: string;

  @IsOptional()
  @IsBoolean()
  is_email_verified?: boolean = false;

  @IsString()
  @MaxLength(30)
  referral_code: string;

  @IsOptional()
  @IsNumber()
  referred_by_user_id?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  vip_level?: number = 0;

  @IsOptional()
  @IsString()
  @IsIn(['ACTIVE', 'BLOCKED', 'SUSPENDED'])
  account_status?: string = 'ACTIVE';

  @IsOptional()
  @IsDateString()
  last_login_at?: string;

  @IsOptional()
  @IsDateString()
  created_at?: string;

  @IsOptional()
  @IsDateString()
  updated_at?: string;
}