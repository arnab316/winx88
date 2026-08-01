// src/channels/dto/channels.dto.ts
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsInt,
  IsIn,
  IsBoolean,
  IsEmail,
  IsDateString,
  IsNotEmpty,
  Min,
  Max,
  MaxLength,
  Matches,
} from 'class-validator';

// ─── VENDOR: stats pull (GET /partner/stats) ────────────────────
export class ChannelStatsQueryDto {
  @IsOptional() @IsDateString()
  dateFrom?: string; // inclusive, YYYY-MM-DD

  @IsOptional() @IsDateString()
  dateTo?: string;   // inclusive, YYYY-MM-DD

  @IsOptional() @IsString()
  channel?: string;  // restrict to one of the vendor's own channel codes

  @IsOptional() @IsIn(['day', 'total'])
  granularity?: 'day' | 'total' = 'total';
}

// ─── ADMIN: vendors ─────────────────────────────────────────────
export class CreateVendorDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsOptional() @IsEmail() @MaxLength(160)
  contactEmail?: string;

  @IsOptional() @IsString()
  notes?: string;
}

export class UpdateVendorDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsEmail() @MaxLength(160)
  contactEmail?: string;

  @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED'])
  status?: 'ACTIVE' | 'SUSPENDED';

  @IsOptional() @IsString()
  notes?: string;
}

// ─── ADMIN: api keys ────────────────────────────────────────────
export class CreateApiKeyDto {
  @IsOptional() @IsString() @MaxLength(80)
  label?: string;

  @IsOptional() @IsDateString()
  expiresAt?: string;
}

// ─── ADMIN: channels ────────────────────────────────────────────
export class CreateChannelDto {
  // The code goes in the tracking URL, so keep it URL-safe and unambiguous.
  // Stored lowercased; the same rule is applied when a click is resolved.
  @IsString() @IsNotEmpty() @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'code may only contain letters, numbers, underscore and hyphen',
  })
  code!: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  name!: string;

  @IsOptional() @Type(() => Number) @IsInt()
  vendorId?: number;

  @IsOptional() @IsString() @MaxLength(40)
  platform?: string; // FACEBOOK | GOOGLE | TIKTOK | ...

  @IsOptional() @IsString() @MaxLength(255)
  landingPath?: string;
}

export class UpdateChannelDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @Type(() => Number) @IsInt()
  vendorId?: number;

  @IsOptional() @IsString() @MaxLength(40)
  platform?: string;

  @IsOptional() @IsString() @MaxLength(255)
  landingPath?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
}

// ─── ADMIN: list queries ────────────────────────────────────────
export class ChannelListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt()
  vendorId?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 50;
}

export class UnknownClickQueryDto {
  @IsOptional() @IsDateString()
  dateFrom?: string;

  @IsOptional() @IsDateString()
  dateTo?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number = 50;
}

// ─── PUBLIC: click beacon (POST /c/track) ───────────────────────
export class TrackClickDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  channel!: string;

  @IsOptional() @IsString() @MaxLength(80)
  subId?: string;

  @IsOptional() @IsString() @MaxLength(255)
  landingPath?: string;

  @IsOptional() @IsString()
  referer?: string;
}
