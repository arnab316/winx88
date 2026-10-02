import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { GAME_KINDS, type GameKind } from '../game-library.service';

/**
 * The global ValidationPipe runs with `whitelist: true`, so every field the
 * client is allowed to send has to be declared here or it is silently stripped.
 */
export class AddFavouriteDto {
  @IsIn(GAME_KINDS, { message: `kind must be one of ${GAME_KINDS.join(', ')}` })
  kind!: GameKind;

  /** provider_id for SLOT, vendor_code for ORO, provider_code for NEXUS. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  providerRef!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  gameCode!: string;

  /* Display snapshot — optional, see the migration for why it is stored. */

  @IsOptional()
  @IsString()
  @MaxLength(255)
  gameName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  gameImage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  providerName?: string;
}

export class RemoveFavouriteDto {
  @IsIn(GAME_KINDS, { message: `kind must be one of ${GAME_KINDS.join(', ')}` })
  kind!: GameKind;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  providerRef!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  gameCode!: string;
}
