import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { PaginationQueryDto } from '../dto/ai-support-query.dto';
import { AiSupportGuard } from '../guards/ai-support.guard';
import { AiSupportPromotionService } from '../services/ai-support-promotion.service';

@ApiTags('AI Support — Promotions')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/promotions')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportPromotionController {
  constructor(private readonly svc: AiSupportPromotionService) {}

  @Get('active')
  @ApiOperation({ summary: 'Promotions this customer can claim now' })
  active(@Req() req: any) {
    return this.svc.listActive(req.aiSupport.userId);
  }

  /**
   * Before :promotionId. The eligibility answer comes from the promotion
   * engine itself, including its refusal message.
   */
  @Get('eligibility')
  @ApiOperation({ summary: 'Whether a promotion can be claimed, and why not' })
  @ApiQuery({ name: 'promotionId', required: true, type: Number })
  @ApiQuery({ name: 'depositAmount', required: false, type: Number })
  eligibility(
    @Req() req: any,
    @Query('promotionId', ParseIntPipe) promotionId: number,
    @Query('depositAmount') depositAmount?: string,
  ) {
    const amount = Number(depositAmount);
    return this.svc.checkEligibility(
      req.aiSupport.userId,
      promotionId,
      Number.isFinite(amount) && amount > 0 ? amount : undefined,
    );
  }

  @Get(':promotionId')
  @ApiOperation({ summary: 'Promotion details' })
  one(@Req() req: any, @Param('promotionId', ParseIntPipe) promotionId: number) {
    return this.svc.getPromotion(req.aiSupport.userId, promotionId);
  }
}

@ApiTags('AI Support — Bonuses')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/bonuses')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportBonusController {
  constructor(private readonly svc: AiSupportPromotionService) {}

  @Get('wagering')
  @ApiOperation({ summary: 'Every active wagering requirement on the account' })
  wagering(@Req() req: any) {
    return this.svc.getWageringOverview(req.aiSupport.userId);
  }

  @Get()
  @ApiOperation({ summary: 'Bonus claim history' })
  list(@Req() req: any, @Query() q: PaginationQueryDto) {
    return this.svc.listBonuses(req.aiSupport.userId, q.page ?? 1, q.limit ?? 20);
  }

  @Get(':bonusId/progress')
  @ApiOperation({ summary: 'Wagering progress for one bonus' })
  progress(@Req() req: any, @Param('bonusId', ParseIntPipe) bonusId: number) {
    return this.svc.getBonusProgress(req.aiSupport.userId, bonusId);
  }

  @Get(':bonusId')
  @ApiOperation({ summary: 'One bonus claim' })
  one(@Req() req: any, @Param('bonusId', ParseIntPipe) bonusId: number) {
    return this.svc.getBonus(req.aiSupport.userId, bonusId);
  }
}
