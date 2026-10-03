import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { AdminGuard } from 'src/common/guards/admin.guard';
import {
  CreateShortcutDto,
  ReorderShortcutsDto,
  UpdateShortcutDto,
} from './dto/shortcut.dto';
import { HomeShortcutsService } from './home-shortcuts.service';

/** Icons render at ~64px, so there is no reason to accept a large file. */
const iconUpload = FileInterceptor('icon', {
  storage: memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/png', 'image/webp', 'image/jpeg', 'image/svg+xml', 'image/gif',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Only PNG, WEBP, JPG, GIF or SVG allowed'), false);
  },
});

/**
 * The round "stories" shortcut row on the player home screen.
 *
 *   GET    /home-shortcuts/active     public — active rows in display order
 *   GET    /home-shortcuts            admin  — all rows incl. inactive
 *   POST   /home-shortcuts            admin  — multipart, field "icon"
 *   PATCH  /home-shortcuts/:id        admin  — multipart, field "icon"
 *   PATCH  /home-shortcuts/reorder    admin  — { ids: [...] } in new order
 *   DELETE /home-shortcuts/:id        admin
 */
@Controller('home-shortcuts')
export class HomeShortcutsController {
  constructor(private readonly shortcuts: HomeShortcutsService) {}

  @Get('active')
  async listActive() {
    const data = await this.shortcuts.listActive();
    return { statusCode: HttpStatus.OK, message: 'Home shortcuts', ...data };
  }

  @UseGuards(AdminGuard)
  @Get()
  async listAll() {
    const data = await this.shortcuts.listAll();
    return { statusCode: HttpStatus.OK, message: 'Home shortcuts', ...data };
  }

  @UseGuards(AdminGuard)
  @Post()
  @UseInterceptors(iconUpload)
  async create(@Body() dto: CreateShortcutDto, @UploadedFile() icon?: Express.Multer.File) {
    const data = await this.shortcuts.create(dto, icon);
    return { statusCode: HttpStatus.CREATED, message: 'Shortcut created', data };
  }

  /**
   * Declared before ':id' so the literal path wins — otherwise Nest would try
   * to parse "reorder" as a numeric id and 400.
   */
  @UseGuards(AdminGuard)
  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(@Body() dto: ReorderShortcutsDto) {
    const data = await this.shortcuts.reorder(dto.ids);
    return { statusCode: HttpStatus.OK, message: 'Shortcuts reordered', ...data };
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  @UseInterceptors(iconUpload)
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateShortcutDto,
    @UploadedFile() icon?: Express.Multer.File,
  ) {
    const data = await this.shortcuts.update(id, dto, icon);
    return { statusCode: HttpStatus.OK, message: 'Shortcut updated', data };
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.shortcuts.remove(id);
    return { statusCode: HttpStatus.OK, message: 'Shortcut deleted', data };
  }
}
