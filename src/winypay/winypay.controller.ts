import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { WinypayService } from './winypay.service';

@Controller('winypay')
export class WinypayController {
  private readonly logger = new Logger(WinypayController.name);

  constructor(private readonly winypay: WinypayService) {}

  // USER: start a WinyPay deposit → returns { payUrl } to redirect/iframe.
  //   POST /winypay/deposit  body: { gatewayId, amount, payType: 'bkash'|'nagad', promotionId?, jumpUrl? }
  @UseGuards(JwtAuthGuard)
  @Post('deposit')
  async initiateDeposit(@Req() req: any, @Body() body: any) {
    const amount = parseFloat(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    if (!body.payType) {
      throw new BadRequestException('payType is required (bkash | nagad)');
    }
    // gatewayId is OPTIONAL — the service auto-resolves the WinyPay gateway.
    // Only honor it if a valid positive number was actually sent.
    const gw = parseInt(body.gatewayId, 10);
    const gatewayId = Number.isFinite(gw) && gw > 0 ? gw : undefined;
    return this.winypay.initiateDeposit({
      userId: req.user.sub,
      gatewayId,
      amount,
      payType: body.payType,
      promotionId: body.promotionId ? parseInt(body.promotionId, 10) : undefined,
      jumpUrl: body.jumpUrl,
    });
  }

  // PROVIDER: final deposit result. Public (no JWT) — authenticated by HMAC.
  // Must return 200 { status: 'ok' }. WinyPay sends this twice (idempotent).
  //   POST /winypay/deposit/callback   header: X-Callback-Sign: <hmac_sha256>
  @Post('deposit/callback')
  @HttpCode(200)
  async depositCallback(
    @Req() req: any,
    @Headers('x-callback-sign') sign?: string,
  ) {
    this.logger.log(
      `[winypay/deposit/callback] IN ip=${req.ip} sign=${sign ? 'present' : 'MISSING'} ` +
        `body=${req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body)}`,
    );
    // req.rawBody is populated by the json({ verify }) parser in main.ts.
    return this.winypay.handleDepositCallback(req.rawBody, sign);
  }
}
