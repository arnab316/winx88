import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Req,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AdminGuard } from '../common/guards/admin.guard';
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

/**
 * Admin turnover management.
 *
 *   GET  /turnover/admin/requirements?status=ACTIVE&search=&userId=&page=&limit=
 *        → the management table: promotion name/code, completed/remaining/target,
 *          created/completed_at, approved_by, status.
 *   POST /turnover/admin/:id/complete   → the "Turnover Complete" action.
 */
@Controller('turnover/admin')
@UseGuards(AdminGuard)
export class TurnoverAdminController {
  constructor(private readonly turnover: TurnoverService) {}

  @Get('requirements')
  list(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('userId') userId?: string,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page = 1,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit = 20,
  ) {
    return this.turnover.adminListRequirements({
      status,
      search: search?.trim() || undefined,
      userId: userId && !isNaN(Number(userId)) ? Number(userId) : undefined,
      page,
      limit,
    });
  }

  @Post(':id/complete')
  complete(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.turnover.adminCompleteTurnover(id, req.user.sub);
  }
}
