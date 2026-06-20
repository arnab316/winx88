import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { ReferralService } from './referral.service';

/**
 * Referrer-facing referral endpoints.
 *
 *   GET /referral/my-link       → invite code, link, headline stats
 *   GET /referral/my-referrals  → list of referrals with progress
 */
@Controller('referral')
@UseGuards(JwtAuthGuard)
export class ReferralController {
  constructor(private readonly referral: ReferralService) {}

  @Get('my-link')
  async myLink(@Req() req: any) {
    try {
      const data = await this.referral.getMyLink(req.user.sub);
      return { success: true, data };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('my-referrals')
  async myReferrals(@Req() req: any) {
    try {
      const data = await this.referral.getMyReferrals(req.user.sub);
      return { success: true, count: data.length, data };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'Failed' },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
