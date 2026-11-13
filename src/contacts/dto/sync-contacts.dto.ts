import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One address-book entry as the device sent it.
 *
 * `name` is optional because a contact can be a bare number with no name.
 * `phone` is not: a nameless number is still useful, a name with no number is
 * not, and the whole table is keyed on the number.
 */
export class DeviceContactDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  phone!: string;
}

/**
 * One chunk of an address book.
 *
 * ArrayMaxSize is the important decorator here, and 400 is not arbitrary.
 * The beta deployment sits behind nginx with the default
 * `client_max_body_size` of 1MB, and nginx's 413 is returned before the app
 * is reached, so it carries no CORS headers and the client sees nothing but a
 * generic network failure. 400 contacts is roughly 40KB of JSON — far enough
 * under the cap that a book of any realistic size survives, as long as the
 * client chunks. A 2,000-contact book is five requests.
 *
 * The global ValidationPipe runs with `whitelist: true`, so anything not
 * decorated here is silently dropped rather than rejected. Adding a field to
 * the client without adding it here means the value never arrives, and
 * nothing says so.
 */
export class SyncContactsDto {
  @IsArray()
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => DeviceContactDto)
  contacts!: DeviceContactDto[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  platform?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceModel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  appVersion?: string;
}
