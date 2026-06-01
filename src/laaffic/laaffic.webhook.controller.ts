import { Controller, Post, Body, Headers, HttpCode, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/**
 * LAAFFIC delivery push receiver.
 *
 * LAAFFIC POSTs delivery results to a URL you provide them (contact support to set it).
 * Body shape (per docs):
 *   {
 *     "appId":  "4luaKsL2",
 *     "orderId":"21412",
 *     "msgid":  "2108021059531000096",   // note: lowercase 'msgid' in PUSH payload
 *     "mobile": "91850000000",
 *     "status": 0,                        // 0 = success, anything else = failure
 *     "reason": "0",
 *     "timestamp": 1629801177192,
 *     "mcc":   "404",
 *     "mnc":   "-1",
 *     "pricedetail": { "pay":"0.02","currency":"EUR","chargeCnt":2,"price":"0.01" }
 *   }
 *
 * Note: MCC=999 in a failure report means invalid or carrier-blocked number.
 *
 * Mount this controller in app.module.ts and give LAAFFIC the URL:
 *   https://your-domain.com/laaffic/webhook/delivery
 *
 * Optional shared-secret protection: set LAAFFIC_WEBHOOK_SECRET in .env, give the same
 * value to LAAFFIC, ask them to send it as `X-Webhook-Secret` header. We reject mismatches.
 */
@Controller('laaffic/webhook')
export class LaafficWebhookController {
  private readonly logger = new Logger(LaafficWebhookController.name);
  private readonly sharedSecret?: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.sharedSecret = this.config.get<string>('LAAFFIC_WEBHOOK_SECRET') || undefined;
  }

  @Post('delivery')
  @HttpCode(200) // LAAFFIC expects 200 — non-200 may trigger retries
  async receiveDelivery(
    @Body() body: any,
    @Headers('x-webhook-secret') incomingSecret?: string,
  ) {
    // Optional auth — only if you configured the secret with LAAFFIC.
    if (this.sharedSecret && incomingSecret !== this.sharedSecret) {
      this.logger.warn('Rejected LAAFFIC webhook — bad/missing X-Webhook-Secret');
      return { ok: false };
    }

    const msgId: string | undefined = body?.msgid ?? body?.msgId;
    const mobile: string | undefined = body?.mobile;
    const status = Number(body?.status);
    const reason: string | undefined = body?.reason;
    const mcc: string | undefined = body?.mcc;

    if (!msgId) {
      this.logger.warn(`Push report missing msgid: ${JSON.stringify(body)}`);
      return { ok: true }; // still 200 — don't make LAAFFIC retry malformed payloads
    }

    const isSuccess = status === 0;
    const isInvalidNumber = !isSuccess && mcc === '999';

    this.logger.log(
      `Push delivery: msgId=${msgId} mobile=${mobile} status=${status} reason=${reason} mcc=${mcc}`,
    );

    // Update the user_otps row that owns this msgId (if any).
    // We store the carrier result so the next OTP request for that phone can
    // tell the user "the previous SMS could not be delivered, please check your number".
    try {
      await this.dataSource.query(
        `UPDATE user_otps
            SET delivery_status = $1,
                delivery_reason = $2,
                delivery_mcc    = $3,
                delivery_reported_at = NOW()
          WHERE provider_msg_id = $4`,
        [
          isSuccess ? 'DELIVERED' : isInvalidNumber ? 'INVALID_NUMBER' : 'FAILED',
          reason ?? null,
          mcc ?? null,
          msgId,
        ],
      );
    } catch (err: any) {
      // Don't 500 to LAAFFIC — we still got the data. Log and move on.
      this.logger.error(`Failed to persist delivery report for msgId=${msgId}: ${err?.message}`);
    }

    return { ok: true };
  }
}