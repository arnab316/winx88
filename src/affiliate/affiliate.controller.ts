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
  DefaultValuePipe,
} from '@nestjs/common';
import { AffiliateService } from './affiliate.service';
import { AffiliateRevShareService } from './affiliate-revshare.service';
import { AffiliateWeeklyService } from './affiliate-weekly.service';
import { AffiliateTransferService } from './affiliate-transfer.service';
import { AffiliateAdminService } from './affiliate-admin.service';
import { VerificationService } from '../verification/verification.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('affiliate')
export class AffiliateController {
  constructor(
    private readonly affiliateService: AffiliateService,
    private readonly revshare: AffiliateRevShareService,
    private readonly weekly: AffiliateWeeklyService,
    private readonly transfers: AffiliateTransferService,
    private readonly affiliateAdmin: AffiliateAdminService,
    private readonly verification: VerificationService,
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
      revshareRate:     body.revshareRate !== undefined ? parseFloat(body.revshareRate) : undefined,
      groupId:          body.groupId !== undefined && body.groupId !== null && body.groupId !== ''
                          ? parseInt(body.groupId) : undefined,
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

  // ─────────────────────────────────────────────────────────────
  // WEEKLY COMMISSION — affiliate-facing (Figma user panel)
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/me/weekly/overview — KPIs: members, active players,
  // week deposits/withdrawals, projected commission, balance, lifetime.
  @UseGuards(JwtAuthGuard)
  @Get('me/weekly/overview')
  weeklyOverview(@Req() req: any) {
    return this.weekly.getWeeklyOverview(req.user.sub);
  }

  // GET /affiliate/me/weekly/history?page&limit — settled Friday weeks
  @UseGuards(JwtAuthGuard)
  @Get('me/weekly/history')
  weeklyHistory(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.weekly.getMyWeeklyHistory(req.user.sub, page, limit);
  }

  // GET /affiliate/me/players/report?from&to&q&page&limit
  //   Per downline player: deposits, withdrawals, profit/loss, category
  //   (ACTIVE / NO_BONUS / INACTIVE). Defaults to the current week.
  @UseGuards(JwtAuthGuard)
  @Get('me/players/report')
  myPlayerReport(
    @Req() req: any,
    @Query('from')  from?: string,
    @Query('to')    to?: string,
    @Query('q')     q?: string,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.weekly.getMyPlayerReport(req.user.sub, {
      from, to, q,
      page:  page  ? parseInt(page)  : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  // GET /affiliate/me/commission-ledger?page&limit — balance statement
  @UseGuards(JwtAuthGuard)
  @Get('me/commission-ledger')
  myCommissionLedger(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.weekly.getMyCommissionLedger(req.user.sub, page, limit);
  }

  // GET /affiliate/me/profile — user-panel Profile page
  @UseGuards(JwtAuthGuard)
  @Get('me/profile')
  myProfile(@Req() req: any) {
    return this.affiliateAdmin.getMyProfile(req.user.sub);
  }

  // GET /affiliate/me/verification — KYC status (affiliates are users, so
  // submission itself uses the existing POST /verification/submit).
  @UseGuards(JwtAuthGuard)
  @Get('me/verification')
  myVerification(@Req() req: any) {
    return this.verification.getMyVerification(req.user.sub);
  }

  // ─────────────────────────────────────────────────────────────
  // TRANSFERS — affiliate-facing
  // ─────────────────────────────────────────────────────────────

  // POST /affiliate/me/transfers  body: { recipient, amount, note? }
  //   recipient = user code / username / numeric user id
  @UseGuards(JwtAuthGuard)
  @Post('me/transfers')
  requestTransfer(@Req() req: any, @Body() body: any) {
    return this.transfers.requestTransfer(req.user.sub, {
      recipient: body.recipient ?? body.recipientId ?? body.userId,
      amount:    parseFloat(body.amount),
      note:      body.note,
    });
  }

  // GET /affiliate/me/transfers?status&page&limit
  @UseGuards(JwtAuthGuard)
  @Get('me/transfers')
  myTransfers(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.transfers.getMyTransfers(req.user.sub, page, limit, status);
  }

  // ─────────────────────────────────────────────────────────────
  // WEEKLY COMMISSION — admin
  // ─────────────────────────────────────────────────────────────

  // POST /affiliate/admin/weekly/run  body: { weekStart?: 'YYYY-MM-DD' (a Friday) }
  //   Defaults to the last completed Friday→Friday week.
  @UseGuards(AdminGuard)
  @Post('admin/weekly/run')
  runWeekly(@Body() body: any) {
    return this.weekly.runWeekly(body?.weekStart);
  }

  // GET /affiliate/admin/:userId/weekly?page&limit — weekly history
  @UseGuards(AdminGuard)
  @Get('admin/:userId/weekly')
  adminWeeklyHistory(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.weekly.getWeeklyHistoryForUser(userId, page, limit);
  }

  // GET /affiliate/admin/:userId/players/report?from&to&q&page&limit
  @UseGuards(AdminGuard)
  @Get('admin/:userId/players/report')
  adminPlayerReport(
    @Param('userId', ParseIntPipe) userId: number,
    @Query('from')  from?: string,
    @Query('to')    to?: string,
    @Query('q')     q?: string,
    @Query('page')  page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.weekly.getPlayerReportForUser(userId, {
      from, to, q,
      page:  page  ? parseInt(page)  : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // GROUPS — admin
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/admin/groups — cards with affiliates/players/deposits stats
  @UseGuards(AdminGuard)
  @Get('admin/groups')
  listGroups() {
    return this.affiliateAdmin.listGroups();
  }

  // POST /affiliate/admin/groups  body: { name, revSharePct, minActivePlayers?, maxActivePlayers? }
  @UseGuards(AdminGuard)
  @Post('admin/groups')
  createGroup(@Req() req: any, @Body() body: any) {
    return this.affiliateAdmin.createGroup(
      {
        name:             body.name,
        revSharePct:      body.revSharePct !== undefined ? parseFloat(body.revSharePct) : undefined as any,
        minActivePlayers: body.minActivePlayers !== undefined && body.minActivePlayers !== '' ? parseInt(body.minActivePlayers) : undefined,
        maxActivePlayers: body.maxActivePlayers !== undefined && body.maxActivePlayers !== null && body.maxActivePlayers !== ''
                            ? parseInt(body.maxActivePlayers) : null,
      },
      req.user.sub,
    );
  }

  // PATCH /affiliate/admin/groups/:id
  @UseGuards(AdminGuard)
  @Patch('admin/groups/:id')
  updateGroup(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
    return this.affiliateAdmin.updateGroup(id, {
      name:             body.name,
      revSharePct:      body.revSharePct !== undefined ? parseFloat(body.revSharePct) : undefined,
      minActivePlayers: body.minActivePlayers !== undefined ? parseInt(body.minActivePlayers) : undefined,
      maxActivePlayers: body.maxActivePlayers === undefined ? undefined
                          : (body.maxActivePlayers === null || body.maxActivePlayers === '' ? null : parseInt(body.maxActivePlayers)),
      isActive:         body.isActive,
    });
  }

  // DELETE /affiliate/admin/groups/:id
  @UseGuards(AdminGuard)
  @Delete('admin/groups/:id')
  deleteGroup(@Param('id', ParseIntPipe) id: number) {
    return this.affiliateAdmin.deleteGroup(id);
  }

  // PATCH /affiliate/admin/:userId/group  body: { groupId: number | null }
  @UseGuards(AdminGuard)
  @Patch('admin/:userId/group')
  assignGroup(@Param('userId', ParseIntPipe) userId: number, @Body() body: any) {
    return this.affiliateAdmin.assignGroup(
      userId,
      body.groupId === null || body.groupId === undefined || body.groupId === ''
        ? null : parseInt(body.groupId),
    );
  }

  // ─────────────────────────────────────────────────────────────
  // TRANSFERS — admin
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/admin/transfers?status&q&from&to&page&limit
  @UseGuards(AdminGuard)
  @Get('admin/transfers')
  adminTransfers(
    @Query('status') status?: string,
    @Query('q')      q?: string,
    @Query('from')   from?: string,
    @Query('to')     to?: string,
    @Query('page')   page?: string,
    @Query('limit')  limit?: string,
  ) {
    return this.transfers.adminListTransfers({
      status, q, from, to,
      page:  page  ? parseInt(page)  : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  // POST /affiliate/admin/transfers/:id/decide  body: { action: 'APPROVE'|'REJECT', rejectionReason? }
  @UseGuards(AdminGuard)
  @Post('admin/transfers/:id/decide')
  decideTransfer(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.transfers.decideTransfer(id, req.user.sub, body.action, body.rejectionReason);
  }

  // ─────────────────────────────────────────────────────────────
  // KYC — admin (affiliate-scoped view over user_verifications)
  // ─────────────────────────────────────────────────────────────

  // GET /affiliate/admin/verifications?status&page&limit
  @UseGuards(AdminGuard)
  @Get('admin/verifications')
  affiliateVerifications(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    return this.affiliateAdmin.listAffiliateVerifications(page, limit, status);
  }

  // POST /affiliate/admin/verifications/:id/decide  body: { action, rejectionReason? }
  @UseGuards(AdminGuard)
  @Post('admin/verifications/:id/decide')
  decideVerification(
    @Req() req: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.affiliateAdmin.decideAffiliateVerification(
      id, req.user.sub, body.action, body.rejectionReason,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // ACCOUNT MANAGEMENT — admin detail page
  // ─────────────────────────────────────────────────────────────

  // PATCH /affiliate/admin/:userId/status  body: { status: ACTIVE|INACTIVE|SUSPENDED|LOCKED, remark? }
  @UseGuards(AdminGuard)
  @Patch('admin/:userId/status')
  updateAffiliateStatus(@Param('userId', ParseIntPipe) userId: number, @Body() body: any) {
    return this.affiliateAdmin.updateStatus(userId, body.status, body.remark);
  }

  // PATCH /affiliate/admin/:userId/contact  body: { fullName?, email?, phone?, remark? }
  @UseGuards(AdminGuard)
  @Patch('admin/:userId/contact')
  updateAffiliateContact(@Param('userId', ParseIntPipe) userId: number, @Body() body: any) {
    return this.affiliateAdmin.updateContact(userId, {
      fullName: body.fullName ?? body.name,
      email:    body.email,
      phone:    body.phone,
      remark:   body.remark,
    });
  }

  // POST /affiliate/admin/:userId/password  body: { newPassword }
  @UseGuards(AdminGuard)
  @Post('admin/:userId/password')
  changeAffiliatePassword(@Param('userId', ParseIntPipe) userId: number, @Body() body: any) {
    return this.affiliateAdmin.changePassword(userId, body.newPassword);
  }
}