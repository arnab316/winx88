import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { BetQueryDto, PaginationQueryDto } from '../dto/ai-support-query.dto';
import { AiSupportGuard } from '../guards/ai-support.guard';
import { AiSupportBetService } from '../services/ai-support-bet.service';

@ApiTags('AI Support — Bets')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/bets')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportBetController {
  constructor(private readonly svc: AiSupportBetService) {}

  /** Before :betId, or "pending" is matched as a bet reference. */
  @Get('pending')
  @ApiOperation({ summary: 'Unsettled bets' })
  pending(@Req() req: any, @Query() q: PaginationQueryDto) {
    return this.svc.listPendingBets(req.aiSupport.userId, q.page ?? 1, q.limit ?? 20);
  }

  @Get()
  @ApiOperation({ summary: 'Bet history across every product' })
  list(@Req() req: any, @Query() q: BetQueryDto) {
    return this.svc.listBets(req.aiSupport.userId, q);
  }

  @Get(':betId/settlement')
  @ApiOperation({
    summary: 'How a bet was settled, from the stored result — never recomputed',
  })
  settlement(@Req() req: any, @Param('betId') betId: string) {
    return this.svc.getSettlement(req.aiSupport.userId, betId);
  }

  @Get(':betId')
  @ApiOperation({ summary: 'One bet from this customer\'s recent history' })
  one(@Req() req: any, @Param('betId') betId: string) {
    return this.svc.getBet(req.aiSupport.userId, betId);
  }
}
