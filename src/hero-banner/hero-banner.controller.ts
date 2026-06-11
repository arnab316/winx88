import {
  Controller, Post, Get, Patch, Delete,
  Param, Body, ParseIntPipe, BadRequestException,
  UploadedFiles, UseInterceptors, UseGuards,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { HeroBannerService } from './hero-banner.service';
import { AdminGuard } from 'src/common/guards/admin.guard';

const uploadInterceptor = FileFieldsInterceptor(
  [
    { name: 'desktop_image', maxCount: 1 },
    { name: 'mobile_image',  maxCount: 1 },
  ],
  {
    storage: memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per image
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp'];
      if (allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException('Only JPG, PNG, WEBP allowed'), false);
      }
    },
  },
);

type BannerFiles = {
  desktop_image?: Express.Multer.File[];
  mobile_image?:  Express.Multer.File[];
};

@Controller('hero-banner')
export class HeroBannerController {
  constructor(private readonly heroBannerService: HeroBannerService) {}

  // ─── Public ──────────────────────────────────────────────────────────────
  /** Returns the currently active banner (used by the frontend) */
  @Get('active')
 async getActiveBanner() {
    try {
      const res=  this.heroBannerService.getActiveBanner();
      return res
    } catch (error:any) {
      throw error;
    }
  }

  // ─── Admin ───────────────────────────────────────────────────────────────
  /** List all banners */
  @UseGuards(AdminGuard)
  @Get()
  getAllBanners() {
    return this.heroBannerService.getAllBanners();
  }

  /** Upload a new banner (desktop + mobile) */
  @UseGuards(AdminGuard)
  @Post()
  @UseInterceptors(uploadInterceptor)
  createBanner(@UploadedFiles() files: BannerFiles) {
    return this.heroBannerService.createBanner(
      files.desktop_image?.[0],
      files.mobile_image?.[0],
    );
  }

  /** Replace images on an existing banner */
  @UseGuards(AdminGuard)
  @Patch(':id')
  @UseInterceptors(uploadInterceptor)
  updateBanner(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: BannerFiles,
  ) {
    return this.heroBannerService.updateBanner(
      id,
      files.desktop_image?.[0],
      files.mobile_image?.[0],
    );
  }

  /** Activate or deactivate a banner */
  @UseGuards(AdminGuard)
  @Patch(':id/toggle')
  toggleActive(
    @Param('id', ParseIntPipe) id: number,
    @Body('is_active') isActive: boolean,
  ) {
    return this.heroBannerService.toggleActive(id, isActive);
  }

  /** Delete a banner */
  @UseGuards(AdminGuard)
  @Delete(':id')
  deleteBanner(@Param('id', ParseIntPipe) id: number) {
    return this.heroBannerService.deleteBanner(id);
  }
}