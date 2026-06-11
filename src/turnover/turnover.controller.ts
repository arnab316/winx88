import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TurnoverService } from './turnover.service';

/**
 * User-facing turnover / wagering endpoints. The target user is taken from the
 * JWT — a user can only ever see their own turnover.
 *
 *   GET /turnover/me               → headline numbers for the wagering page
 *   GET /turnover/me/requirements  → per-requirement breakdown
 *   GET /turnover/me/history?page= → paginated turnover ledger
 */
@Controller('turnover')
@UseGuards(JwtAuthGuard)
export class TurnoverController {
  constructor(private readonly turnover: TurnoverService) {}

  @Get('me')
  getMySummary(@Req() req: any) {
    return this.turnover.getMyTurnoverSummary(req.user.sub);
  }

  @Get('me/requirements')
  getMyRequirements(@Req() req: any) {
    return this.turnover.getMyActiveRequirements(req.user.sub);
  }

  @Get('me/history')
  getMyHistory(
    @Req() req: any,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.turnover.getMyTurnoverHistory(req.user.sub, page, limit);
  }
}
