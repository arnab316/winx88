// src/promotion-cms/promotion-cms.controller.ts
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, UseGuards,
  ParseIntPipe, UsePipes, ValidationPipe,
  UseInterceptors, UploadedFile, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { PromotionCmsService } from './promotion-cms.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { S3Service } from '../wallet/s3.service';
import {
  CreatePromotionCmsDto,
  UpdatePromotionCmsDto,
  ListPromotionCmsQueryDto,
  PublicPromotionCmsQueryDto,
  ReorderPromotionCmsDto,
} from './dto/promotion-cms.dto';

const BANNER_VARIANTS = ['banner_en', 'banner_bn', 'small_banner_en', 'small_banner_bn'] as const;
type BannerVariant = typeof BANNER_VARIANTS[number];

@Controller('promotion-cms')
@UsePipes(new ValidationPipe({
  whitelist: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
}))
export class PromotionCmsController {
  constructor(
    private readonly cms: PromotionCmsService,
    private readonly s3: S3Service,
  ) {}

  // ─── PUBLIC (GUEST) ───────────────────────────────────────────
  @Get('public')
  publicList(@Query() q: PublicPromotionCmsQueryDto) {
    return this.cms.publicList(q, null);
  }

  @Get('public/:id')
  publicGetOne(@Param('id', ParseIntPipe) id: number) {
    return this.cms.publicGetOne(id, null);
  }

  // ─── AUTHENTICATED USER ───────────────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Get('me')
  myList(@Req() req: any, @Query() q: PublicPromotionCmsQueryDto) {
    return this.cms.publicList(q, req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/:id')
  myGetOne(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.cms.publicGetOne(id, req.user.sub);
  }

  // ─── ADMIN: CRUD ──────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query() q: ListPromotionCmsQueryDto) {
    return this.cms.list(q);
  }

  @UseGuards(AdminGuard)
  @Get('admin/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.cms.getOne(id);
  }

  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreatePromotionCmsDto) {
    return this.cms.create(dto, req.user.sub);
  }

  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePromotionCmsDto,
  ) {
    return this.cms.update(id, dto, req.user.sub);
  }

  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  deactivate(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.cms.deactivate(id, req.user.sub);
  }

  @UseGuards(AdminGuard)
  @Post('admin/reorder')
  reorder(@Req() req: any, @Body() dto: ReorderPromotionCmsDto) {
    return this.cms.reorder(dto, req.user.sub);
  }

  // ─── ADMIN: BANNER UPLOAD ─────────────────────────────────────
  //
  // POST /promotion-cms/admin/upload-banner
  //   form-data:
  //     file    = <image file>           (required)
  //     variant = banner_en | banner_bn | small_banner_en | small_banner_bn  (required)
  //
  // Returns: { url, variant }
  //
  // The admin then includes that URL in the next create/update request.
  // This keeps the upload separate so the admin can preview before saving
  // and reuse the same upload for multiple variants if desired.
  @UseGuards(AdminGuard)
  @Post('admin/upload-banner')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new BadRequestException('Only JPG, PNG, WEBP, GIF allowed'), false);
      },
    }),
  )
  async uploadBanner(
    @UploadedFile() file: Express.Multer.File,
    @Body('variant') variant: BannerVariant,
  ) {
    if (!file) {
      throw new BadRequestException('File is required (form-data key "file")');
    }
    if (!BANNER_VARIANTS.includes(variant)) {
      throw new BadRequestException(
        `variant must be one of: ${BANNER_VARIANTS.join(', ')}`,
      );
    }

    const url = await this.s3.uploadPromotionBanner(file, variant);
    return { url, variant };
  }
}