// src/notification/dto/notification.dto.ts
import { Type, Transform } from 'class-transformer';
import {
  IsString, IsOptional, IsBoolean, IsInt, IsIn, IsArray,
  Min, Max, Length, IsObject, ValidateNested, ArrayMinSize,
} from 'class-validator';

export const NOTIFICATION_CATEGORIES = [
  'TRANSACTIONAL', 'GAMEPLAY', 'PROMOTIONAL', 'SECURITY',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = [
  'IN_APP', 'SOCKET', 'PUSH', 'SMS', 'EMAIL',
] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Only TRANSACTIONAL and SECURITY are exempt from preference suppression.
 * A player cannot opt out of being told their withdrawal was declined.
 */
export const ALWAYS_ON_CATEGORIES: NotificationCategory[] = [
  'TRANSACTIONAL', 'SECURITY',
];

const toBool = ({ value }: { value: any }) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return value;
};

const toUpperEnum = ({ value }: { value: any }) => {
  if (value === '' || value === null || value === undefined) return undefined;
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
};

// ─── PLAYER: inbox list ─────────────────────────────────────────
export class ListMyNotificationsQueryDto {
  /**
   * Catch-up cursor. The client sends the highest id it already holds and gets
   * everything newer — this is what makes a dropped socket harmless.
   */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  sinceId?: number;

  @IsOptional() @Transform(toUpperEnum) @IsIn(NOTIFICATION_CATEGORIES)
  category?: NotificationCategory;

  @IsOptional() @Transform(toBool) @IsBoolean()
  unreadOnly?: boolean;

  @IsOptional() @IsString() @Length(2, 5)
  locale?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;
}

// ─── PLAYER: preferences ────────────────────────────────────────
export class PreferenceItemDto {
  @Transform(toUpperEnum) @IsIn(NOTIFICATION_CATEGORIES)
  category!: NotificationCategory;

  @Transform(toUpperEnum) @IsIn(NOTIFICATION_CHANNELS)
  channel!: NotificationChannel;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdatePreferencesDto {
  // @ValidateNested + @Type are load-bearing: without them class-transformer
  // leaves the array as plain objects, and `whitelist: true` then strips every
  // property, so the service receives {category: undefined, ...}.
  @IsArray() @ValidateNested({ each: true })
  @Type(() => PreferenceItemDto)
  @ArrayMinSize(1)
  items!: PreferenceItemDto[];
}

// ─── ADMIN: send / broadcast ────────────────────────────────────
export class SendNotificationDto {
  /**
   * Which template to render. Defaults to ADMIN_BROADCAST, the free-text one.
   */
  @IsOptional() @IsString() @Length(2, 64)
  eventKey?: string;

  /** Omit BOTH this and `usernames` to broadcast to every active player. */
  @IsOptional() @IsArray() @IsInt({ each: true })
  userIds?: number[];

  /**
   * Recipients by username — what an admin actually has in front of them.
   *
   * Merged with `userIds` when both are given, and de-duplicated, so the two
   * can be mixed freely. Matching is case-insensitive.
   *
   * An unknown name is an ERROR, not a silent skip: an admin who types five
   * names and gets four notifications delivered has no way to know, and the
   * one player who needed the message is the one who did not get it.
   */
  @IsOptional() @IsArray() @IsString({ each: true }) @Length(1, 64, { each: true })
  usernames?: string[];

  /** Narrow a broadcast to one VIP tier. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  vipLevel?: number;

  @IsOptional() @IsString() @Length(1, 200)
  title?: string;

  @IsOptional() @IsString()
  body?: string;

  @IsOptional() @IsString() @Length(1, 200)
  titleBn?: string;

  @IsOptional() @IsString()
  bodyBn?: string;

  @IsOptional() @IsString() @Length(0, 200)
  deepLink?: string;

  /** Extra {{placeholder}} values for the chosen template. */
  @IsOptional() @IsObject()
  payload?: Record<string, any>;
}

// ─── ADMIN: template CRUD ───────────────────────────────────────
export class UpsertTemplateDto {
  @IsString() @Length(2, 64)
  eventKey!: string;

  @IsOptional() @Transform(toUpperEnum) @IsIn(NOTIFICATION_CATEGORIES)
  category?: NotificationCategory;

  @IsOptional() @IsArray() @IsIn(NOTIFICATION_CHANNELS, { each: true })
  channels?: NotificationChannel[];

  @IsString() @Length(1, 200) titleEn!: string;
  @IsString() bodyEn!: string;

  @IsOptional() @IsString() @Length(0, 200) titleBn?: string;
  @IsOptional() @IsString() bodyBn?: string;

  @IsOptional() @IsString() @Length(0, 200) deepLink?: string;
  @IsOptional() @IsString() @Length(0, 64) icon?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class ListTemplatesQueryDto {
  @IsOptional() @Transform(toBool) @IsBoolean()
  isActive?: boolean;

  @IsOptional() @Transform(toUpperEnum) @IsIn(NOTIFICATION_CATEGORIES)
  category?: NotificationCategory;
}

/** What a caller hands to NotificationService.enqueue(). */
export interface EnqueueNotification {
  eventKey: string;
  userId: number;
  payload?: Record<string, any>;
  /** Makes a retried enqueue a no-op instead of a second notification. */
  idempotencyKey?: string;
}
