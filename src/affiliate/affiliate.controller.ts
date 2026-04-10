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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('affiliate')
export class AffiliateController {
  constructor(private readonly affiliateService: AffiliateService) {}

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

  // GET /affiliate/admin/list?page=1&limit=20
  @UseGuards(AdminGuard)
  @Get('admin/list')
  getAllAffiliates(
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.affiliateService.getAllAffiliates(page, limit);
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
}