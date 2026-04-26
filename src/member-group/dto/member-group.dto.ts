// src/member-group/dto/member-group.dto.ts
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  IsInt,
  ArrayMinSize,
  Length,
  Matches,
} from 'class-validator';

export class CreateMemberGroupDto {
  @IsString()
  @Length(1, 100)
  name: string = '';

  @IsString()
  @Length(2, 40)
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'code must be UPPERCASE letters, digits, and underscores only',
  })
  code: string = '';

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateMemberGroupDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AddUsersToGroupDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  userIds: number[] = [];
}

export class RemoveUsersFromGroupDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  userIds: number[] = [];
}