import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';

import { AiSupportGuard } from '../guards/ai-support.guard';
import { AiSupportUserService } from '../services/ai-support-user.service';

/**
 * Account, status, restrictions and KYC.
 *
 * The customer is resolved from the signed token by AiSupportGuard and put on
 * `req.aiSupport`. No route here takes a customer id — an agent that could
 * name its own subject could read any account.
 */
@ApiTags('AI Support — User')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/user')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportUserController {
  constructor(private readonly svc: AiSupportUserService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Customer profile (phone masked)' })
  profile(@Req() req: any) {
    return this.svc.getProfile(req.aiSupport.userId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Account status and what the customer may do' })
  status(@Req() req: any) {
    return this.svc.getStatus(req.aiSupport.userId);
  }

  @Get('restrictions')
  @ApiOperation({ summary: 'Active restrictions, each with its source' })
  restrictions(@Req() req: any) {
    return this.svc.getRestrictions(req.aiSupport.userId);
  }
}

@ApiTags('AI Support — KYC')
@ApiSecurity('x-ai-support-key')
@Controller('internal/ai-support/kyc')
@UseGuards(ThrottlerGuard, AiSupportGuard)
export class AiSupportKycController {
  constructor(private readonly svc: AiSupportUserService) {}

  @Get('status')
  @ApiOperation({
    summary: 'KYC state and next steps. Never returns document contents.',
  })
  status(@Req() req: any) {
    return this.svc.getKycStatus(req.aiSupport.userId);
  }
}
