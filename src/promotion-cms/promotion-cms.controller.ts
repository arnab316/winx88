// src/promotion-cms/promotion-cms.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { PromotionCmsService } from './promotion-cms.service';
import { S3Service } from '../wallet/s3.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import {
  CreatePromotionCmsDto,
  UpdatePromotionCmsDto,
  ListPromotionCmsQueryDto,
  FeedQueryDto,
  ReorderCmsDto,
  SUPPORTED_LANGS,
  SupportedLang,
} from './dto/promotion-cms.dto';

@Controller('promotion-cms')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class PromotionCmsController {
  constructor(
    private readonly cmsService: PromotionCmsService,
    private readonly s3Service: S3Service,
  ) {}

  // ─── PUBLIC FEED ─────────────────────────────────────────────

  // GET /promotion-cms/feed?lang=en&loggedIn=true&tag=Sport
  // No auth — promos visible to logged-out users too (display_before_login)
  @Get('feed')
  feed(@Query() q: FeedQueryDto) {
    return this.cmsService.feed(q);
  }

  // ─── ADMIN ───────────────────────────────────────────────────

  // GET /promotion-cms/admin?currency=BDT&isActive=true&tag=Sport
  @UseGuards(AdminGuard)
  @Get('admin')
  list(@Query() q: ListPromotionCmsQueryDto) {
    return this.cmsService.list(q);
  }

  // GET /promotion-cms/admin/:id
  @UseGuards(AdminGuard)
  @Get('admin/:id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.cmsService.getOne(id);
  }

  // POST /promotion-cms/admin
  @UseGuards(AdminGuard)
  @Post('admin')
  create(@Req() req: any, @Body() dto: CreatePromotionCmsDto) {
    return this.cmsService.create(dto, req.user.sub);
  }

  // PATCH /promotion-cms/admin/:id
  @UseGuards(AdminGuard)
  @Patch('admin/:id')
  update(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePromotionCmsDto,
  ) {
    return this.cmsService.update(id, dto, req.user.sub);
  }

  // DELETE /promotion-cms/admin/:id?hard=true
  @UseGuards(AdminGuard)
  @Delete('admin/:id')
  remove(
    @Param('id', ParseIntPipe) id: number,
    @Query('hard') hard?: string,
  ) {
    return this.cmsService.deleteOrDeactivate(id, hard === 'true');
  }

  // POST /promotion-cms/admin/reorder
  // body: { items: [{id, sequence}, ...] }
  @UseGuards(AdminGuard)
  @Post('admin/reorder')
  reorder(@Req() req: any, @Body() dto: ReorderCmsDto) {
    return this.cmsService.reorder(dto, req.user.sub);
  }

  // POST /promotion-cms/admin/:id/banner
  // form-data: file=<image>, lang=en|bn, size=large|small
  @UseGuards(AdminGuard)
  @Post('admin/:id/banner')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        cb(
          allowed.includes(file.mimetype)
            ? null
            : new BadRequestException('Only JPG, PNG, WEBP allowed'),
          allowed.includes(file.mimetype),
        );
      },
    }),
  )
  async uploadBanner(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @Body('lang') lang: string,
    @Body('size') size: string,
  ) {
    if (!file) throw new BadRequestException('file is required (form-data field "file")');

    if (!SUPPORTED_LANGS.includes(lang as SupportedLang)) {
      throw new BadRequestException(`lang must be one of: ${SUPPORTED_LANGS.join(', ')}`);
    }
    if (size !== 'large' && size !== 'small') {
      throw new BadRequestException("size must be 'large' or 'small'");
    }

    // Upload to S3 — reuse existing uploadDepositScreenshot pattern
    // (assumes your S3Service has a generic upload method — if not,
    // copy the deposit screenshot upload logic and target a different folder)
    const url = await this.s3Service.uploadPromotionBanner(file, id, lang, size);
    if (!url) throw new BadRequestException('S3 upload returned empty URL');

    return this.cmsService.setBannerUrl(
      id,
      lang as SupportedLang,
      size as 'large' | 'small',
      url,
      req.user.sub,
    );
  }
}