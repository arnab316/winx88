import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseIntPipe,
  DefaultValuePipe,
  UseInterceptors,
  BadRequestException,
  InternalServerErrorException,
  UploadedFile,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { S3Service } from './s3.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService, private readonly s3Service: S3Service) {}

  // ─────────────────────────────────────────────────────────────
  // USER ROUTES
  // ─────────────────────────────────────────────────────────────

  // GET /wallet
  @UseGuards(JwtAuthGuard)
  @Get('/balance')
  getWallet(@Req() req: any) {
    return this.walletService.getWallet(req.user.sub);
  }

  // GET /wallet/history?page=1&limit=20
  @UseGuards(JwtAuthGuard)
  @Get('history')
  getLedgerHistory(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.walletService.getLedgerHistory(req.user.sub, page, limit);
  }

  // POST /wallet/deposit
  @UseGuards(JwtAuthGuard)
  @Post('deposit')
  @UseInterceptors(
    FileInterceptor('screenshot', {
      storage: memoryStorage(),               // buffer in RAM → send straight to S3
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
      fileFilter: (_req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (allowed.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Only JPG, PNG, WEBP allowed'), false);
        }
      },
    }),
  )
async requestDeposit(
    @Req() req: any,
    @UploadedFile() screenshot: Express.Multer.File,
    @Body() body: any,
  ) {
    // ── debug: remove after confirming it works ──────────────
    console.log('screenshot received:', screenshot?.originalname ?? 'UNDEFINED');
    console.log('body received:', body);
    // ─────────────────────────────────────────────────────────
 
    if (!screenshot) {
      throw new BadRequestException(
        'Screenshot file is required. Send as form-data with key "screenshot"',
      );
    }
 
    // 1. Upload to S3 → returns S3 key: "deposits/uuid.jpg"
    const screenshotUrl = await this.s3Service.uploadDepositScreenshot(screenshot);
 
    console.log('screenshotUrl after S3:', screenshotUrl); // ← debug
 
    if (!screenshotUrl) {
      throw new InternalServerErrorException('S3 upload returned empty URL');
    }
 
    // 2. Save deposit record + ledger entry
    return this.walletService.requestDeposit({
      userId:            req.user.sub,
      gatewayId:         parseInt(body.gatewayId),
      amount:            parseFloat(body.amount),
      transactionNumber: body.transactionNumber,
      screenshotUrl,
    });
  }


  // POST /wallet/withdraw
  @UseGuards(JwtAuthGuard)
  @Post('withdraw')
  requestWithdrawal(@Req() req: any, @Body() body: any) {
    return this.walletService.requestWithdrawal({
      userId:        req.user.sub,
      gatewayId:     body.gatewayId,
      amount:        body.amount,
      receiveNumber: body.receiveNumber,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN ROUTES
  // ─────────────────────────────────────────────────────────────

  // GET /wallet/admin/deposits?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/deposits')
  getPendingDeposits(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.walletService.getPendingDeposits(page, limit);
  }

  // POST /wallet/admin/deposits/:id/decide
  // body: { action: 'APPROVE' | 'REJECT', rejectionReason?: string }
  @UseGuards(AdminGuard)
  @Post('admin/deposits/:id/decide')
  decideDeposit(
    @Req() req: any,
    @Param('id', ParseIntPipe) depositId: number,
    @Body() body: any,
  ) {
    return this.walletService.decideDeposit({
      depositId,
      adminId:         req.user.sub,
      action:          body.action,
      rejectionReason: body.rejectionReason,
    });
  }

  // GET /wallet/admin/withdrawals?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/withdrawals')
  getPendingWithdrawals(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.walletService.getPendingWithdrawals(page, limit);
  }

  // POST /wallet/admin/withdrawals/:id/decide
  // body: { action: 'APPROVE' | 'REJECT', rejectionReason?: string }
  @UseGuards(AdminGuard)
  @Post('admin/withdrawals/:id/decide')
  decideWithdrawal(
    @Req() req: any,
    @Param('id', ParseIntPipe) withdrawalId: number,
    @Body() body: any,
  ) {
    return this.walletService.decideWithdrawal({
      withdrawalId,
      adminId:         req.user.sub,
      action:          body.action,
      rejectionReason: body.rejectionReason,
    });
  }

  // POST /wallet/admin/adjust
  // body: { userId, amount, description, meta? }
  @UseGuards(AdminGuard)
  @Post('admin/adjust')
  adminAdjustWallet(@Req() req: any, @Body() body: any) {
    return this.walletService.adminAdjustWallet({
      userId:      body.userId,
      adminId:     req.user.sub,
      amount:      body.amount,
      description: body.description,
      meta:        body.meta,
    });
  }
}