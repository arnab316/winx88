import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { AdminGuard } from 'src/common/guards/admin.guard';
import { OptionalJwtAuthGuard } from 'src/common/guards/optional-jwt-auth.guard';
import { GAME_KINDS, type GameKind } from 'src/game-library/game-library.service';
import {
  ReorderGameContentDto,
  UpdateGameContentDto,
  UpsertGameContentDto,
  VALID_BADGES,
} from './dto/game-content.dto';
import {
  GameContentService,
  type GameBadge,
  type ListSort,
} from './game-content.service';

const imageUpload = (field: string, mb: number) =>
  FileInterceptor(field, {
    storage: memoryStorage(),
    limits: { fileSize: mb * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'];
      if (allowed.includes(file.mimetype)) cb(null, true);
      else cb(new BadRequestException('Only PNG, WEBP, JPG or GIF allowed'), false);
    },
  });

/**
 * Admin-authored game content, and the collection screens it drives.
 *
 * Public:
 *   GET /game-content/list?badge=HOT&kind=SLOT&q=&sort=&page=&limit=
 *   GET /game-content/detail/:kind/:providerRef/:gameCode
 *   GET /game-content/detail/:kind/:providerRef/:gameCode/similar
 *
 * The public routes use OptionalJwtAuthGuard: anyone can browse, but a signed-in
 * player also gets `isFavourite` on each row.
 *
 * Admin:
 *   GET    /game-content            POST   /game-content
 *   PATCH  /game-content/reorder    PATCH  /game-content/:id
 *   DELETE /game-content/:id        POST   /game-content/screenshot
 *   GET    /game-content/search-games?q=
 */
@Controller('game-content')
export class GameContentController {
  constructor(private readonly content: GameContentService) {}

  /* ─────────────────────────── Public ──────────────────────────── */

  @UseGuards(OptionalJwtAuthGuard)
  @Get('list')
  async list(
    @Req() req: any,
    @Query('badge') badge?: string,
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(24), ParseIntPipe) limit = 24,
  ) {
    const badgeUp = badge?.toUpperCase();
    const kindUp = kind?.toUpperCase();
    const sortUp = sort?.toUpperCase();

    const data = await this.content.listPublic(
      {
        badge: badgeUp && VALID_BADGES.includes(badgeUp) ? (badgeUp as GameBadge) : undefined,
        kind: kindUp && GAME_KINDS.includes(kindUp as GameKind) ? (kindUp as GameKind) : undefined,
        q,
        sort: (['ORDER', 'NAME', 'NEWEST'].includes(sortUp ?? '')
          ? sortUp
          : 'ORDER') as ListSort,
        page,
        limit,
      },
      req.user?.sub,
    );
    return { statusCode: HttpStatus.OK, message: 'Games', ...data };
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('detail/:kind/:providerRef/:gameCode')
  async detail(
    @Req() req: any,
    @Param('kind') kind: string,
    @Param('providerRef') providerRef: string,
    @Param('gameCode') gameCode: string,
  ) {
    const data = await this.content.getDetail(
      this.assertKind(kind),
      providerRef,
      gameCode,
      req.user?.sub,
    );
    return { statusCode: HttpStatus.OK, message: 'Game detail', data };
  }

  @Get('detail/:kind/:providerRef/:gameCode/similar')
  async similar(
    @Param('kind') kind: string,
    @Param('providerRef') providerRef: string,
    @Param('gameCode') gameCode: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit = 10,
  ) {
    const data = await this.content.getSimilar(
      this.assertKind(kind),
      providerRef,
      gameCode,
      limit,
    );
    return { statusCode: HttpStatus.OK, message: 'Similar games', ...data };
  }

  /* ──────────────────────────── Admin ──────────────────────────── */

  /** Declared before the ':id' routes so literal paths aren't parsed as ids. */
  @UseGuards(AdminGuard)
  @Get('search-games')
  async searchGames(
    @Query('q') q: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    const data = await this.content.searchCatalog(q, limit);
    return { statusCode: HttpStatus.OK, message: 'Catalog search', ...data };
  }

  @UseGuards(AdminGuard)
  @Get()
  async listAll(
    @Query('q') q?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit = 25,
  ) {
    const data = await this.content.listAll({ q, page, limit });
    return { statusCode: HttpStatus.OK, message: 'Game content', ...data };
  }

  @UseGuards(AdminGuard)
  @Post()
  @UseInterceptors(imageUpload('cover', 5))
  async upsert(@Body() dto: UpsertGameContentDto, @UploadedFile() cover?: Express.Multer.File) {
    const data = await this.content.upsert(dto, cover);
    return { statusCode: HttpStatus.CREATED, message: 'Game content saved', data };
  }

  @UseGuards(AdminGuard)
  @Post('screenshot')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(imageUpload('screenshot', 5))
  async uploadScreenshot(@UploadedFile() screenshot?: Express.Multer.File) {
    const data = await this.content.uploadScreenshot(screenshot as Express.Multer.File);
    return { statusCode: HttpStatus.OK, message: 'Screenshot uploaded', data };
  }

  @UseGuards(AdminGuard)
  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(@Body() dto: ReorderGameContentDto) {
    const data = await this.content.reorder(dto.ids);
    return { statusCode: HttpStatus.OK, message: 'Reordered', ...data };
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  @UseInterceptors(imageUpload('cover', 5))
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateGameContentDto,
    @UploadedFile() cover?: Express.Multer.File,
  ) {
    const data = await this.content.update(id, dto, cover);
    return { statusCode: HttpStatus.OK, message: 'Game content updated', data };
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.content.remove(id);
    return { statusCode: HttpStatus.OK, message: 'Game content deleted', data };
  }

  private assertKind(kind: string): GameKind {
    const k = String(kind || '').toUpperCase() as GameKind;
    if (!GAME_KINDS.includes(k)) {
      throw new BadRequestException(`kind must be one of ${GAME_KINDS.join(', ')}`);
    }
    return k;
  }
}
