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
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AffiliateRevShareService } from './affiliate-revshare.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('affiliate')
export class AffiliateController {
  constructor(
    private readonly affiliateService: AffiliateService,
    private readonly revshare: AffiliateRevShareService,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // USER ROUTES
  // ─────────────────────────────────────────────────────────────

  // POST /affiliate/apply
  // body: { notes?: string }
  @UseGuards(JwtAuthGuard)
  @Post('apply')
  apply(@Req() req: any, @Body() body: any) {
    return this.affiliateService.applyAffiliate({
      userId: req.user.sub,
      notes:  body.notes,
    });
  }

  // GET /affiliate/status
  @UseGuards(JwtAuthGuard)
  @Get('status')
  getStatus(@Req() req: any) {
    return this.affiliateService.getMyAffiliateStatus(req.user.sub);
  }

  // GET /affiliate/summary
  @UseGuards(JwtAuthGuard)
  @Get('summary')
  getSummary(@Req() req: any) {
    return this.affiliateService.getMyAffiliateSummary(req.user.sub);
  }

  // GET /affiliate/downline?page=1&limit=20
  @UseGuards(JwtAuthGuard)
  @Get('downline')
  getDownline(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.affiliateService.getMyDownline(req.user.sub, page, limit);
  }

  // GET /affiliate/bonuses?page=1&limit=20
  @UseGuards(JwtAuthGuard)
  @Get('bonuses')
  getBonuses(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.affiliateService.getMyReferralBonuses(req.user.sub, page, limit);
  }

  // ─────────────────────────────────────────────────────────────
  // ADMIN ROUTES
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/admin/applications?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/applications')
  getPendingApplications(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.affiliateService.getPendingApplications(page, limit);
  }

  // POST /affiliate/admin/applications/:id/decide
  // body: { action: 'APPROVE'|'REJECT', commissionPct?: number, rejectionReason?: string }
  @UseGuards(AdminGuard)
  @Post('admin/applications/:id/decide')
  decideApplication(
    @Req() req: any,
    @Param('id', ParseIntPipe) applicationId: number,
    @Body() body: any,
  ) {
    return this.affiliateService.decideApplication({
      applicationId,
      adminId:          req.user.sub,
      action:           body.action,
      commissionPct:    body.commissionPct ? parseFloat(body.commissionPct) : 0,
      rejectionReason:  body.rejectionReason,
    });
  }

  // GET /affiliate/admin/list?page=1&limit=20&q=&code=&tier=&status=&from=&to=
  @UseGuards(AdminGuard)
  @Get('admin/list')
  getAllAffiliates(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('q')      q?: string,
    @Query('code')   code?: string,
    @Query('tier')   tier?: string,
    @Query('status') status?: string,
    @Query('from')   from?: string,
    @Query('to')     to?: string,
  ) {
    return this.affiliateService.getAllAffiliates(page, limit, {
      q:      q?.trim() || undefined,
      code:   code?.trim() || undefined,
      tier:   tier !== undefined && tier !== '' && !isNaN(Number(tier)) ? Number(tier) : undefined,
      status: status === 'active' || status === 'inactive' ? status : undefined,
      from:   from || undefined,
      to:     to || undefined,
    });
  }

  // PATCH /affiliate/admin/commission
  // body: { affiliateUserId, commissionPct }
  @UseGuards(AdminGuard)
  @Patch('admin/commission')
  updateCommission(@Req() req: any, @Body() body: any) {
    return this.affiliateService.updateCommission({
      affiliateUserId: parseInt(body.affiliateUserId),
      adminId:         req.user.sub,
      commissionPct:   parseFloat(body.commissionPct),
    });
  }

  // PATCH /affiliate/admin/toggle
  // body: { affiliateUserId, isActive: true|false }
  @UseGuards(AdminGuard)
  @Patch('admin/toggle')
  toggleAffiliate(@Req() req: any, @Body() body: any) {
    return this.affiliateService.toggleAffiliate({
      affiliateUserId: parseInt(body.affiliateUserId),
      adminId:         req.user.sub,
      isActive:        body.isActive === true || body.isActive === 'true',
    });
  }

  // GET /affiliate/admin/:userId/downline?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/:userId/downline')
  getAffiliateDownline(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.affiliateService.getAffiliateDownline(userId, page, limit);
  }

  // GET /affiliate/downline/:userId  — single downline user detail
@UseGuards(JwtAuthGuard)
@Get('downline/:userId')
getDownlineUser(
  @Req() req: any,
  @Param('userId', ParseIntPipe) targetUserId: number,
) {
  return this.affiliateService.getMyDownlineUser(req.user.sub, targetUserId);
}

  // ─────────────────────────────────────────────────────────────
  // REVSHARE — affiliate-facing (build-guide §7)
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/me/overview — tier, active players, MTD NGR, projected payout
  @UseGuards(JwtAuthGuard)
  @Get('me/overview')
  revshareOverview(@Req() req: any) {
    return this.revshare.getOverview(req.user.sub);
  }

  // GET /affiliate/me/players — referred players (alias of downline)
  @UseGuards(JwtAuthGuard)
  @Get('me/players')
  revsharePlayers(
    @Req() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.affiliateService.getMyDownline(req.user.sub, page, limit);
  }

  // GET /affiliate/me/payouts — historical monthly payouts
  @UseGuards(JwtAuthGuard)
  @Get('me/payouts')
  revsharePayouts(@Req() req: any) {
    return this.revshare.getMyPayouts(req.user.sub);
  }

  // GET /affiliate/me/link — tracking link / referral code
  @UseGuards(JwtAuthGuard)
  @Get('me/link')
  revshareLink(@Req() req: any) {
    return this.revshare.getMyLink(req.user.sub);
  }

  // ─────────────────────────────────────────────────────────────
  // REVSHARE — admin
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/admin/revshare/config
  @UseGuards(AdminGuard)
  @Get('admin/revshare/config')
  getRevshareConfig() {
    return this.revshare.getConfig();
  }

  // PATCH /affiliate/admin/revshare/config
  @UseGuards(AdminGuard)
  @Patch('admin/revshare/config')
  updateRevshareConfig(@Req() req: any, @Body() body: any) {
    return this.revshare.updateConfig(body, req.user.sub);
  }

  // POST /affiliate/admin/payouts/run   body: { month: 'YYYY-MM' }
  @UseGuards(AdminGuard)
  @Post('admin/payouts/run')
  runPayouts(@Body() body: any) {
    return this.revshare.runMonthly(body.month);
  }

  // GET /affiliate/admin/payouts/pending?month=YYYY-MM
  @UseGuards(AdminGuard)
  @Get('admin/payouts/pending')
  pendingPayouts(@Query('month') month?: string) {
    return this.revshare.getPendingPayouts(month);
  }

  // POST /affiliate/admin/payouts/:id/mark-paid   body: { txnRef, paidAt? }
  @UseGuards(AdminGuard)
  @Post('admin/payouts/:id/mark-paid')
  markPaid(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.revshare.markPaid(id, body.txnRef, body.paidAt);
  }

  // PATCH /affiliate/admin/:affiliateUserId/revshare
  //   body: { customRate?, paymentMethod?, paymentDetails? }
  @UseGuards(AdminGuard)
  @Patch('admin/:affiliateUserId/revshare')
  setRevshare(
    @Param('affiliateUserId', ParseIntPipe) affiliateUserId: number,
    @Body() body: any,
  ) {
    return this.revshare.setRevshare(affiliateUserId, {
      customRate: body.customRate !== undefined ? parseFloat(body.customRate) : undefined,
      paymentMethod: body.paymentMethod,
      paymentDetails: body.paymentDetails,
    });
  }

  // GET /affiliate/admin/:affiliateUserId/ngr-history
  @UseGuards(AdminGuard)
  @Get('admin/:affiliateUserId/ngr-history')
  ngrHistory(@Param('affiliateUserId', ParseIntPipe) affiliateUserId: number) {
    return this.revshare.getNgrHistory(affiliateUserId);
  }

  // GET /affiliate/admin/:userId/detail — consolidated affiliate detail + KPIs
  // (:userId is the user's id, matching admin/:userId/downline)
  @UseGuards(AdminGuard)
  @Get('admin/:userId/detail')
  affiliateDetail(@Param('userId', ParseIntPipe) userId: number) {
    return this.revshare.getAffiliateDetail(userId);
  }
}