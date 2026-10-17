import { Controller, Get, Param, ParseIntPipe, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { DepositQueryDto, WithdrawalQueryDto } from '../dto/ai-support-query.dto';
import { AiSupportGuard } from '../guards/ai-support.guard';
import { AiSupportPaymentService } from '../services/ai-support-payment.service';

@ApiTags('AI Support — Deposits')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/deposits')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportDepositController {
  constructor(private readonly svc: AiSupportPaymentService) {}

  @Get()
  @ApiOperation({ summary: 'Deposit history, filterable by status' })
  list(@Req() req: any, @Query() q: DepositQueryDto) {
    return this.svc.listDeposits(
      req.aiSupport.userId, q.page ?? 1, q.limit ?? 20, q.status,
    );
  }

  @Get(':depositId')
  @ApiOperation({ summary: 'One deposit belonging to this customer' })
  one(@Req() req: any, @Param('depositId', ParseIntPipe) depositId: number) {
    return this.svc.getDeposit(req.aiSupport.userId, depositId);
  }
}

@ApiTags('AI Support — Withdrawals')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/withdrawals')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportWithdrawalController {
  constructor(private readonly svc: AiSupportPaymentService) {}

  /**
   * Declared BEFORE :withdrawalId — Nest matches in declaration order, so the
   * other way round "eligibility" is read as an id and fails ParseIntPipe.
   */
  @Get('eligibility')
  @ApiOperation({
    summary: 'Whether a withdrawal can be made now, and what is blocking it',
  })
  eligibility(@Req() req: any) {
    return this.svc.getWithdrawalEligibility(req.aiSupport.userId);
  }

  @Get()
  @ApiOperation({ summary: 'Withdrawal history, filterable by status' })
  list(@Req() req: any, @Query() q: WithdrawalQueryDto) {
    return this.svc.listWithdrawals(
      req.aiSupport.userId, q.page ?? 1, q.limit ?? 20, q.status,
    );
  }

  @Get(':withdrawalId')
  @ApiOperation({ summary: 'One withdrawal belonging to this customer' })
  one(@Req() req: any, @Param('withdrawalId', ParseIntPipe) withdrawalId: number) {
    return this.svc.getWithdrawal(req.aiSupport.userId, withdrawalId);
  }
}
