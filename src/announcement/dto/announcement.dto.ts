import { IsString, IsOptional, IsBoolean, Length } from 'class-validator';

// Admin: create a marquee announcement line
export class CreateAnnouncementDto {
  @IsString() @Length(1, 500)
  message!: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

// Admin: update text and/or active state
export class UpdateAnnouncementDto {
  @IsOptional() @IsString() @Length(1, 500)
  message?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}
