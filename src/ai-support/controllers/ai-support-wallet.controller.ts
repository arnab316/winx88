import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { TransactionQueryDto } from '../dto/ai-support-query.dto';
import { AiSupportGuard } from '../guards/ai-support.guard';
import { AiSupportWalletService } from '../services/ai-support-wallet.service';

@ApiTags('AI Support — Wallet')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/wallet')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportWalletController {
  constructor(private readonly svc: AiSupportWalletService) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Balance, bonus balance and what wagering is locking',
  })
  summary(@Req() req: any) {
    return this.svc.getSummary(req.aiSupport.userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Ledger history, with customer-facing labels' })
  transactions(@Req() req: any, @Query() q: TransactionQueryDto) {
    return this.svc.getTransactions(
      req.aiSupport.userId,
      q.page ?? 1,
      q.limit ?? 20,
      q.type,
    );
  }
}
