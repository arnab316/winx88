import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AddFavouriteDto, RemoveFavouriteDto } from './dto/favourite.dto';
import { GameLibraryService } from './game-library.service';

/**
 * The signed-in player's personal game library.
 *
 *   GET    /me/continue-playing?limit=12
 *   GET    /me/favourites
 *   POST   /me/favourites
 *   DELETE /me/favourites
 *
 * Favourites are removed with a body rather than path params because a game is
 * identified by a (kind, providerRef, gameCode) triple and game codes contain
 * characters that are awkward to round-trip through a URL segment.
 */
@Controller('me')
@UseGuards(JwtAuthGuard)
export class GameLibraryController {
  constructor(private readonly library: GameLibraryService) {}

  @Get('continue-playing')
  async continuePlaying(
    @Req() req: any,
    @Query('limit', new DefaultValuePipe(12), ParseIntPipe) limit = 12,
  ) {
    try {
      const data = await this.library.getContinuePlaying(req.user.sub, limit);
      return { statusCode: HttpStatus.OK, message: 'Continue playing', ...data };
    } catch (error: any) {
      throw this.wrap(error, 'Failed to fetch continue playing');
    }
  }

  @Get('favourites')
  async listFavourites(@Req() req: any) {
    try {
      const data = await this.library.listFavourites(req.user.sub);
      return { statusCode: HttpStatus.OK, message: 'Favourites', ...data };
    } catch (error: any) {
      throw this.wrap(error, 'Failed to fetch favourites');
    }
  }

  @Post('favourites')
  @HttpCode(HttpStatus.OK)
  async addFavourite(@Req() req: any, @Body() dto: AddFavouriteDto) {
    try {
      const data = await this.library.addFavourite(req.user.sub, dto);
      return { statusCode: HttpStatus.OK, message: 'Added to favourites', data };
    } catch (error: any) {
      throw this.wrap(error, 'Failed to add favourite');
    }
  }

  @Delete('favourites')
  @HttpCode(HttpStatus.OK)
  async removeFavourite(@Req() req: any, @Body() dto: RemoveFavouriteDto) {
    try {
      const data = await this.library.removeFavourite(req.user.sub, dto);
      return { statusCode: HttpStatus.OK, message: 'Removed from favourites', data };
    } catch (error: any) {
      throw this.wrap(error, 'Failed to remove favourite');
    }
  }

  private wrap(error: any, fallback: string) {
    return new HttpException(
      {
        statusCode: error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
        message: error?.response?.message || error?.message || fallback,
      },
      error?.status || HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
