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
  CreatePromoBannerDto,
  ReorderPromoBannersDto,
  UpdatePromoBannerDto,
} from './dto/promo-banner.dto';
import { PromoBannersService } from './promo-banners.service';

/** Banner artwork is wide, so allow more headroom than a 64px shortcut icon. */
const bannerUpload = FileInterceptor('image', {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/webp', 'image/jpeg', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new BadRequestException('Only PNG, WEBP, JPG or GIF allowed'), false);
  },
});

/**
 * The promo tile strip on the player home screen (Daily Cashback / Refer &
 * Earn). Each tile is a clickable image whose destination the admin chooses.
 *
 *   GET    /promo-banners/active     public
 *   GET    /promo-banners            admin
 *   POST   /promo-banners            admin (multipart, field "image")
 *   PATCH  /promo-banners/reorder    admin
 *   PATCH  /promo-banners/:id        admin (multipart, field "image")
 *   DELETE /promo-banners/:id        admin
 */
@Controller('promo-banners')
export class PromoBannersController {
  constructor(private readonly banners: PromoBannersService) {}

  @Get('active')
  async listActive() {
    const data = await this.banners.listActive();
    return { statusCode: HttpStatus.OK, message: 'Promo banners', ...data };
  }

  @UseGuards(AdminGuard)
  @Get()
  async listAll() {
    const data = await this.banners.listAll();
    return { statusCode: HttpStatus.OK, message: 'Promo banners', ...data };
  }

  @UseGuards(AdminGuard)
  @Post()
  @UseInterceptors(bannerUpload)
  async create(@Body() dto: CreatePromoBannerDto, @UploadedFile() image?: Express.Multer.File) {
    const data = await this.banners.create(dto, image);
    return { statusCode: HttpStatus.CREATED, message: 'Banner created', data };
  }

  /** Before ':id' so the literal path isn't parsed as a numeric id. */
  @UseGuards(AdminGuard)
  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(@Body() dto: ReorderPromoBannersDto) {
    const data = await this.banners.reorder(dto.ids);
    return { statusCode: HttpStatus.OK, message: 'Banners reordered', ...data };
  }

  @UseGuards(AdminGuard)
  @Patch(':id')
  @UseInterceptors(bannerUpload)
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePromoBannerDto,
    @UploadedFile() image?: Express.Multer.File,
  ) {
    const data = await this.banners.update(id, dto, image);
    return { statusCode: HttpStatus.OK, message: 'Banner updated', data };
  }

  @UseGuards(AdminGuard)
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const data = await this.banners.remove(id);
    return { statusCode: HttpStatus.OK, message: 'Banner deleted', data };
  }
}
