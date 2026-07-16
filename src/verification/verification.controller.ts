// src/verification/verification.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { VerificationService } from './verification.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('verification')
export class VerificationController {
  constructor(private readonly verificationService: VerificationService) {}

  // ═══════════════════════════════════════════════════════════════
  // USER ROUTES
  // ═══════════════════════════════════════════════════════════════

  // POST /verification/submit
  // form-data: documentType, documentNumber, expiryDate,
  //            frontImage (file), backImage (file), selfieImage (file)
  @UseGuards(JwtAuthGuard)
  @Post('submit')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'frontImage', maxCount: 1 },
        { name: 'backImage', maxCount: 1 },
        { name: 'selfieImage', maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB per file
        fileFilter: (_req, file, cb) => {
          const allowed = ['image/jpeg', 'image/png'];
          if (allowed.includes(file.mimetype)) {
            cb(null, true);
          } else {
            cb(
              new BadRequestException(
                `${file.fieldname}: only JPG and PNG are allowed`,
              ),
              false,
            );
          }
        },
      },
    ),
  )
  async submitVerification(
    @Req() req: any,
    @UploadedFiles()
    files: {
      frontImage?: Express.Multer.File[];
      backImage?: Express.Multer.File[];
      selfieImage?: Express.Multer.File[];
    },
    @Body() body: any,
  ) {
    const frontFile = files?.frontImage?.[0];
    const backFile  = files?.backImage?.[0];
    const selfieFile = files?.selfieImage?.[0];

    if (!body.documentType)   throw new BadRequestException('documentType is required');
    if (!body.documentNumber) throw new BadRequestException('documentNumber is required');
    // expiryDate is optional — validated only when provided (see service).
    if (!frontFile)           throw new BadRequestException('frontImage file is required');
    if (!backFile)            throw new BadRequestException('backImage file is required');
    if (!selfieFile)          throw new BadRequestException('selfieImage (selfie holding document) is required');

    return this.verificationService.submitVerification(
      req.user.sub,
      {
        documentType:   body.documentType,
        documentNumber: body.documentNumber,
        expiryDate:     body.expiryDate,
      },
      frontFile,
      backFile,
      selfieFile,
    );
  }

  // GET /verification/my-status
  @UseGuards(JwtAuthGuard)
  @Get('my-status')
  getMyVerification(@Req() req: any) {
    return this.verificationService.getMyVerification(req.user.sub);
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ═══════════════════════════════════════════════════════════════

  // GET /verification/admin/stats
  @UseGuards(AdminGuard)
  @Get('admin/stats')
  getStats() {
    return this.verificationService.getStats();
  }

  // GET /verification/admin/list?page=1&limit=20&status=PENDING
  @UseGuards(AdminGuard)
  @Get('admin/list')
  listVerifications(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.verificationService.listVerifications(page, limit, status);
  }

  // GET /verification/admin/user/:userId
  @UseGuards(AdminGuard)
  @Get('admin/user/:userId')
  getByUserId(@Param('userId', ParseIntPipe) userId: number) {
    return this.verificationService.getVerificationByUserId(userId);
  }

  // GET /verification/admin/:id
  @UseGuards(AdminGuard)
  @Get('admin/:id')
  getById(@Param('id', ParseIntPipe) id: number) {
    return this.verificationService.getVerificationById(id);
  }

  // PATCH /verification/admin/:id/under-review
  @UseGuards(AdminGuard)
  @Patch('admin/:id/under-review')
  markUnderReview(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.verificationService.markUnderReview(id, req.user.sub);
  }

  // PATCH /verification/admin/:id/review
  // body: { action: 'APPROVE' | 'REJECT', rejectionReason?: string }
  @UseGuards(AdminGuard)
  @Patch('admin/:id/review')
  reviewVerification(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: any,
    @Body() body: any,
  ) {
    if (!body.action || !['APPROVE', 'REJECT'].includes(body.action)) {
      throw new BadRequestException('action must be APPROVE or REJECT');
    }

    return this.verificationService.reviewVerification(
      id,
      req.user.sub,
      body.action,
      body.rejectionReason,
    );
  }
}