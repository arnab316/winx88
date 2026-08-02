
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
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { S3Service } from './s3.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
@Controller('wallet')
export class WalletController {
  // Use Nest's built-in logger — auto-silenced in production if needed.
  // Replaces the bare console.log() debug calls.
  private readonly logger = new Logger(WalletController.name);
 
  constructor(
    private readonly walletService: WalletService,
    private readonly s3Service: S3Service,
  ) {}
 
  // ═════════════════════════════════════════════════════════════
  // USER ROUTES
  // ═════════════════════════════════════════════════════════════
 
  // GET /wallet/balance — full wallet snapshot incl. coins + VIP
  @UseGuards(JwtAuthGuard)
  @Get('balance')
  getWallet(@Req() req: any) {
    return this.walletService.getWallet(req.user.sub);
  }
 
  // GET /wallet/history?page=1&limit=20
  @UseGuards(JwtAuthGuard)
  @Get('history')
 getLedgerHistory(
  @Req() req: any,
  @Query('page',   new DefaultValuePipe(1),  ParseIntPipe) page:  number,
  @Query('limit',  new DefaultValuePipe(20), ParseIntPipe) limit: number,
  @Query('type') typeFilter?: string,
) {
  return this.walletService.getLedgerHistory(
    req.user.sub, page, limit, typeFilter, 'USER',   // ← 'USER'
  );
}
 
  // POST /wallet/deposit/validate
  // body (JSON): { gatewayId, amount, promotionId? }
  // Pre-flight check the frontend MUST call when the user clicks "Deposit",
  // BEFORE showing the agent number. Returns { valid: true } if the deposit
  // would be accepted, otherwise throws the same error the real deposit would
  // (min amount, phone not verified, gateway inactive, promo ineligible, …).
  // No file upload, nothing persisted — safe to call as often as needed.
  @UseGuards(JwtAuthGuard)
  @Post('deposit/validate')
  async validateDeposit(@Req() req: any, @Body() body: any) {
    const amount = parseFloat(body.amount);
    const gatewayId = parseInt(body.gatewayId, 10);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      throw new BadRequestException('gatewayId is required');
    }

    return this.walletService.validateDeposit({
      userId:      req.user.sub,
      gatewayId,
      amount,
      promotionId: body.promotionId ? parseInt(body.promotionId, 10) : undefined,
    });
  }

  // POST /wallet/deposit
  // form-data: screenshot=<file>, gatewayId, amount, transactionNumber,
  //            agentId (recommended), promotionId (optional),
  //            playerNumber (optional — which of the player's own numbers they
  //            paid from; GET /user/profile lists them for the dropdown)
  @UseGuards(JwtAuthGuard)
  @Post('deposit')
  @UseInterceptors(
    FileInterceptor('screenshot', {
      storage: memoryStorage(),
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
    // Dev-only debug logging (silent in production)
    if (process.env.NODE_ENV !== 'production') {
      this.logger.debug(
        `Deposit request: file=${screenshot?.originalname ?? 'NONE'}, body=${JSON.stringify(body)}`,
      );
    }
       

 
    if (!screenshot) {
      throw new BadRequestException(
        'Screenshot file is required. Send as form-data with key "screenshot"',
      );
    }
 
    // Validate basic body fields BEFORE we waste time on S3 upload
    const amount = parseFloat(body.amount);
    const gatewayId = parseInt(body.gatewayId, 10);
 
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      throw new BadRequestException('gatewayId is required');
    }
    if (!body.transactionNumber || typeof body.transactionNumber !== 'string') {
      throw new BadRequestException('transactionNumber is required');
    }
 
    // 1. Upload to S3 (only after validation passes)
    const screenshotUrl = await this.s3Service.uploadDepositScreenshot(screenshot);
    if (!screenshotUrl) {
      throw new InternalServerErrorException('S3 upload returned empty URL');
    }
 
    // 2. Save deposit record + ledger entry
    return this.walletService.requestDeposit({
      userId:            req.user.sub,
      gatewayId,
      amount,
      transactionNumber: body.transactionNumber,
      screenshotUrl,
      agentId:           body.agentId    ? parseInt(body.agentId, 10)    : undefined,
      promotionId:       body.promotionId ? parseInt(body.promotionId, 10) : undefined,
      // Which of the player's own numbers they paid from (dropdown selection).
      // Validated against user_phone_numbers in the service; omit to default to
      // their primary number, which is what happened before this existed.
      playerNumber:      body.playerNumber,
    });
  }

  // POST /wallet/withdraw
  // body: { gatewayId, amount, receiveNumber }
  @UseGuards(JwtAuthGuard)
  @Post('withdraw')
  requestWithdrawal(@Req() req: any, @Body() body: any) {
    // Coerce + validate (your old version assumed JSON gave you numbers; not always true)
    const amount = parseFloat(body.amount);
    const gatewayId = parseInt(body.gatewayId, 10);
 
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    if (!Number.isFinite(gatewayId) || gatewayId <= 0) {
      throw new BadRequestException('gatewayId is required');
    }
    if (!body.receiveNumber || typeof body.receiveNumber !== 'string') {
      throw new BadRequestException('receiveNumber is required');
    }
 
    return this.walletService.requestWithdrawal({
      userId:        req.user.sub,
      gatewayId,
      amount,
      receiveNumber: body.receiveNumber,
    });
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ═════════════════════════════════════════════════════════════

  // GET /wallet/admin/transactions?userId=42&page=1&limit=20&type=DEPOSIT|WITHDRAWAL
  // Money-movement statement (deposits + withdrawals) for one player.
  // Same feed as the user-facing /wallet/history, but targets any userId and
  // uses admin-facing labels (e.g. "MANUAL DEPOSIT", "MANUAL ADJUST").
  @UseGuards(AdminGuard)
  @Get('admin/transactions')
  getUserTransactions(
    @Query('userId', ParseIntPipe) userId: number,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') typeFilter?: string,
  ) {
    return this.walletService.getLedgerHistory(
      userId, page, limit, typeFilter, 'ADMIN',
    );
  }

  // GET /wallet/admin/adjustments?userId=42&page=1&limit=20
  // A user's ADJUSTMENT statement: admin manual wallet adjustments (credit/
  // debit) + affiliate-commission credits the user RECEIVED — nothing else.
  // Same response shape as /wallet/admin/transactions (filtered feed).
  @UseGuards(AdminGuard)
  @Get('admin/adjustments')
  getUserAdjustments(
    @Query('userId', ParseIntPipe) userId: number,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.walletService.getLedgerHistory(
      userId, page, limit, 'ADJUSTMENT,AFFILIATE', 'ADMIN',
    );
  }

  // GET /wallet/admin/deposits?page=1&limit=20
  // Now returns agent_number, agent_code, wallet_type per deposit
  // (so admin sees WHERE the user was told to send the money)
  // RBAC: deposit.view to open the list; deposit.filter to use the search
  // fields (member group / member id / user id / phone / trx id / dp id /
  // date range / gateway) — mirrors the admin-panel "Use deposit filters".
  @UseGuards(AdminGuard, PermissionsGuard)
  @RequirePermissions('deposit', 'view')
  @Get('admin/deposits')
  getDeposits(
    @Req() req: any,
    @Query('status')      status?:      string,
    @Query('search')      search?:      string,
    @Query('gatewayId')   gatewayId?:   string,
    @Query('provider')    provider?:    string,
    @Query('userId')      userId?:      string,
    @Query('dateFrom')    dateFrom?:    string,
    @Query('dateTo')      dateTo?:      string,
    @Query('memberGroup') memberGroup?: string,
    @Query('memberId')    memberId?:    string,
    @Query('phone')       phone?:       string,
    @Query('trxId')       trxId?:       string,
    @Query('dpId')        dpId?:        string,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number = 20,
  ) {
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'];
    const safeStatus = validStatuses.includes(status?.toUpperCase() ?? '')
      ? (status!.toUpperCase() as any)
      : 'PENDING';

    // Search fields need deposit.filter on top of deposit.view (status tabs
    // and paging stay view-level). req.rbac is set by PermissionsGuard.
    const usesFilters = [
      search, gatewayId, provider, userId, dateFrom, dateTo,
      memberGroup, memberId, phone, trxId, dpId,
    ].some((v) => v?.toString().trim());
    if (usesFilters && req.rbac && !req.rbac.isSuperAdmin
        && !req.rbac.flat.has('deposit.filter')) {
      throw new ForbiddenException('Missing permission: deposit.filter');
    }

    return this.walletService.getPendingDeposits({
      status:      safeStatus,
      search:      search?.trim()      || undefined,
      gatewayId:   gatewayId ? parseInt(gatewayId, 10) : undefined,
      provider:    provider?.trim()    || undefined,
      userId:      userId    ? parseInt(userId,    10) : undefined,
      dateFrom:    dateFrom  || undefined,
      dateTo:      dateTo    || undefined,
      memberGroup: memberGroup?.trim() || undefined,
      memberId:    memberId?.trim()    || undefined,
      phone:       phone?.trim()       || undefined,
      trxId:       trxId?.trim()       || undefined,
      dpId:        dpId?.trim()        || undefined,
      page,
      limit,
    });
  }

    // Single deposit detail — full info including who approved it.

  @UseGuards(AdminGuard, PermissionsGuard)
  @RequirePermissions('deposit', 'view')
  @Get('admin/deposits/:id')
  getDepositById(@Param('id', ParseIntPipe) depositId: number) {
    return this.walletService.getDepositById(depositId);
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
    if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
      throw new BadRequestException("action must be 'APPROVE' or 'REJECT'");
    }
    if (body.action === 'REJECT' && !body.rejectionReason) {
      throw new BadRequestException('rejectionReason is required when rejecting');
    }
 
    return this.walletService.decideDeposit({
      depositId,
      adminId:         req.user.sub,
      action:          body.action,
      rejectionReason: body.rejectionReason,
    });
  }

  // POST /wallet/admin/deposits/:id/reopen
  // Puts a deposit the pending-timeout watcher auto-rejected back into the
  // PENDING queue, so a genuine deposit nobody got to in time can still be
  // approved. Rejections an admin actually made are NOT reopenable.
  // RBAC: deposit.approve — reopening is a step towards crediting money.
  @UseGuards(AdminGuard, PermissionsGuard)
  @RequirePermissions('deposit', 'approve')
  @Post('admin/deposits/:id/reopen')
  reopenDeposit(
    @Req() req: any,
    @Param('id', ParseIntPipe) depositId: number,
  ) {
    return this.walletService.reopenDeposit(depositId, req.user.sub);
  }

  // GET /wallet/admin/withdrawals?page=1&limit=20&status=PENDING|APPROVED|REJECTED|ALL
  // status defaults to PENDING (the approval queue).
  // RBAC: withdraw.view to open the list; withdraw.filter to use the search
  // fields — mirrors the deposit search panel.
  @UseGuards(AdminGuard, PermissionsGuard)
  @RequirePermissions('withdraw', 'view')
  @Get('admin/withdrawals')
  getPendingWithdrawals(
    @Req() req: any,
    @Query('status')      status?:      string,
    @Query('search')      search?:      string,
    @Query('gatewayId')   gatewayId?:   string,
    @Query('userId')      userId?:      string,
    @Query('dateFrom')    dateFrom?:    string,
    @Query('dateTo')      dateTo?:      string,
    @Query('memberGroup') memberGroup?: string,
    @Query('memberId')    memberId?:    string,
    @Query('phone')       phone?:       string,
    @Query('trxId')       trxId?:       string,
    @Query('wdId')        wdId?:        string,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number = 20,
  ) {
    const valid = ['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as const;
    const normalized = (status ?? 'PENDING').toUpperCase();
    if (!valid.includes(normalized as any)) {
      throw new BadRequestException(
        `status must be one of: ${valid.join(', ')}`,
      );
    }

    // Search fields need withdraw.filter on top of withdraw.view (status tabs
    // and paging stay view-level). req.rbac is set by PermissionsGuard.
    const usesFilters = [
      search, gatewayId, userId, dateFrom, dateTo,
      memberGroup, memberId, phone, trxId, wdId,
    ].some((v) => v?.toString().trim());
    if (usesFilters && req.rbac && !req.rbac.isSuperAdmin
        && !req.rbac.flat.has('withdraw.filter')) {
      throw new ForbiddenException('Missing permission: withdraw.filter');
    }

    return this.walletService.getPendingWithdrawals({
      status:      normalized as (typeof valid)[number],
      search:      search?.trim()      || undefined,
      gatewayId:   gatewayId ? parseInt(gatewayId, 10) : undefined,
      userId:      userId    ? parseInt(userId,    10) : undefined,
      dateFrom:    dateFrom  || undefined,
      dateTo:      dateTo    || undefined,
      memberGroup: memberGroup?.trim() || undefined,
      memberId:    memberId?.trim()    || undefined,
      phone:       phone?.trim()       || undefined,
      trxId:       trxId?.trim()       || undefined,
      wdId:        wdId?.trim()        || undefined,
      page,
      limit,
    });
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
    if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
      throw new BadRequestException("action must be 'APPROVE' or 'REJECT'");
    }
    if (body.action === 'REJECT' && !body.rejectionReason) {
      throw new BadRequestException('rejectionReason is required when rejecting');
    }
 
    return this.walletService.decideWithdrawal({
      withdrawalId,
      adminId:         req.user.sub,
      action:          body.action,
      rejectionReason: body.rejectionReason,
    });
  }
 
  // POST /wallet/admin/manual-deposit
  // body: { usernameOrPhone, amount, gatewayId, playerNumber?, trxNumber?,
  //         promotionId?, turnoverMultiplier?, description? }
  //   Creates an already-APPROVED deposit row and runs the full approval
  //   side-effects (credit, coins, promo bonus, turnover, referral progress).
  //   turnoverMultiplier: omit = default 1×, 0 = none; ignored when a
  //   promotion is attached (the promo defines its own turnover).
  @UseGuards(AdminGuard)
  @Post('admin/manual-deposit')
  adminManualDeposit(@Body() body: any, @Req() req: any) {
    return this.walletService.adminManualDeposit({
      adminId:         req.user.sub,
      usernameOrPhone: body.usernameOrPhone,
      amount:          Number(body.amount),
      gatewayId:       Number(body.gatewayId),
      playerNumber:    body.playerNumber,
      trxNumber:       body.trxNumber,
      promotionId:
        body.promotionId !== undefined && body.promotionId !== null && body.promotionId !== ''
          ? Number(body.promotionId) : undefined,
      turnoverMultiplier:
        body.turnoverMultiplier !== undefined && body.turnoverMultiplier !== null && body.turnoverMultiplier !== ''
          ? Number(body.turnoverMultiplier) : undefined,
      description:     body.description,
    });
  }

  // GET /wallet/admin/gateways — the "Wallet" dropdown (bKash, Nagad, …)
  @UseGuards(AdminGuard)
  @Get('admin/gateways')
  listGateways() {
    return this.walletService.listGatewaysAdmin();
  }

  // POST /wallet/admin/adjust
  // body: { userId, amount (signed: + credit, - debit), adjustmentType,
  //         description, meta?, turnoverMultiplier? }
  //   turnoverMultiplier (credit only): amount × multiplier = turnover to clear.
  //   0/omitted = no turnover requirement. description = requirement header.
  @UseGuards(AdminGuard)
  @Post('admin/adjust')
  adminAdjust(@Body() body: any, @Req() req: any) {
    return this.walletService.adminAdjustWallet({
      // Coerce — JSON may send these as strings; the service does arithmetic
      // on amount, so a string would concatenate ("2383.52" + "-300").
      userId:         Number(body.userId),
      amount:         Number(body.amount),
      adjustmentType: body.adjustmentType,
      description:    body.description,
      meta:           body.meta,
      turnoverMultiplier:
        body.turnoverMultiplier !== undefined && body.turnoverMultiplier !== null
          ? Number(body.turnoverMultiplier)
          : undefined,
      adminId:        req.user.sub,   // admin identity from the JWT, never the body
    });
  }
}
 


