import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { WalletService } from '../wallet/wallet.service';
import { WinypayClient } from './winypay.client';

@Injectable()
export class WinypayService {
  private readonly logger = new Logger(WinypayService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly client: WinypayClient,
    private readonly wallet: WalletService,
  ) {}

  // Public origin WinyPay must be able to reach for callbacks.
  private callbackBase(): string {
    return (
      this.config.get<string>('WINYPAY_CALLBACK_BASE') ??
      this.config.get<string>('APP_BASE_URL') ??
      ''
    ).replace(/\/+$/, '');
  }

  // Which pay_type values WinyPay accepts. Documented: bkash, nagad. Override
  // via WINYPAY_PAY_TYPES (csv) ONLY after WinyPay confirms they route others
  // (e.g. upay, rocket) — no code change needed then.
  private allowedPayTypes(): string[] {
    return (this.config.get<string>('WINYPAY_PAY_TYPES') ?? 'bkash,nagad')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  // Resolve our internal WinyPay gateway row (deposits.gateway_id is NOT NULL
  // and the deposit gate validates it). The frontend doesn't need to know it —
  // /winypay/deposit is already WinyPay-specific — so we look it up here.
  private async resolveWinyPayGatewayId(): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT id FROM payment_gateways
        WHERE name = 'WinyPay' AND type = 'ONLINE' AND is_active = TRUE
        ORDER BY id LIMIT 1`,
    );
    if (!rows.length) {
      throw new BadRequestException('WinyPay gateway is not configured/active');
    }
    return Number(rows[0].id);
  }

  // ── User-initiated deposit → returns pay_url to open ──
  async initiateDeposit(args: {
    userId: number;
    gatewayId?: number;     // optional — auto-resolved to the WinyPay gateway if omitted
    amount: number;
    payType: string;
    promotionId?: number;
    jumpUrl?: string;
  }) {
    const payType = (args.payType || '').toLowerCase();
    const allowed = this.allowedPayTypes();
    if (!allowed.includes(payType)) {
      throw new BadRequestException(
        `payType must be one of: ${allowed.join(', ')} (WinyPay-supported methods)`,
      );
    }

    const gatewayId = args.gatewayId ?? (await this.resolveWinyPayGatewayId());

    // 1. Create a PENDING deposit (runs the standard deposit gate; reuses the
    //    deposits table so admin lists / history / turnover all see it).
    const { depositId, depositCode } = await this.wallet.createProviderDeposit({
      userId: args.userId,
      gatewayId,
      amount: args.amount,
      payType,
      provider: 'WINYPAY',
      promotionId: args.promotionId,
    });

    // 2. Forward to WinyPay. order_id = our deposit_code (unique).
    const callbackUrl = `${this.callbackBase()}/winypay/deposit/callback`;
    const jumpUrl = args.jumpUrl || `${this.callbackBase()}/deposit-return`;
    const res = await this.client.payin({
      order_id: depositCode,
      user_id: String(args.userId),
      amount: args.amount.toFixed(2),
      pay_type: payType,
      jump_url: jumpUrl,
      callback_url: callbackUrl,
      current_time: this.now(),
    });

    // 3. Provider refused → reject the pending deposit so it doesn't linger.
    if (res.status !== 'success' || !res.pay_url) {
      await this.wallet
        .rejectDepositFromProvider(
          depositId,
          res.message || 'Provider relay failed',
          res.internal_txn_id,
        )
        .catch((e) =>
          this.logger.warn(`reject after payin-failure failed: ${e?.message}`),
        );
      throw new BadGatewayException(
        res.message || 'Failed to initiate deposit with WinyPay',
      );
    }

    // 4. Stash pay_url + provider txn id; user is redirected to pay_url.
    await this.dataSource.query(
      `UPDATE deposits SET pay_url = $1, provider_txn_id = $2, updated_at = NOW() WHERE id = $3`,
      [res.pay_url, res.internal_txn_id ?? null, depositId],
    );

    return { depositId, orderId: depositCode, payUrl: res.pay_url };
  }

  // ── Provider callback — FINAL source of truth. HMAC-verified + idempotent. ──
  async handleDepositCallback(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ) {
    const raw = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : rawBody ?? '';

    if (!this.verifySignature(raw, signature)) {
      this.logger.warn('[WinyPay callback] REJECTED: bad/missing X-Callback-Sign');
      throw new BadRequestException('Invalid callback signature');
    }

    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }

    const orderId = body.order_id;
    const txnId = body.transaction_id ?? body.internal_txn_id ?? null;
    const status = String(body.status ?? '').toLowerCase();
    this.logger.log(
      `[WinyPay callback] order_id=${orderId} txn=${txnId} status=${status} amount=${body.amount}`,
    );
    if (!orderId) throw new BadRequestException('order_id missing');

    const [dep] = await this.dataSource.query(
      `SELECT id, status FROM deposits WHERE deposit_code = $1 AND provider = 'WINYPAY' LIMIT 1`,
      [orderId],
    );
    if (!dep) {
      // Unknown order — ack so WinyPay stops retrying; nothing to credit.
      this.logger.warn(`[WinyPay callback] no WinyPay deposit for order_id=${orderId}`);
      return { status: 'success' }; // WinyPay requires this exact ack body
    }

    // Idempotency: callbacks arrive twice (immediate + ~1s). Only a PENDING
    // deposit is actionable. The credit path also re-checks status inside its
    // own transaction (DB-level guard) — we catch that race below too.
    if (dep.status !== 'PENDING') {
      this.logger.log(
        `[WinyPay callback] deposit ${dep.id} already ${dep.status} — idempotent skip`,
      );
      return { status: 'success' }; // WinyPay requires this exact ack body
    }

    try {
      if (status === 'success') {
        await this.wallet.approveDepositFromProvider(Number(dep.id), txnId);
        this.logger.log(`[WinyPay callback] deposit ${dep.id} APPROVED + credited`);
      } else {
        await this.wallet.rejectDepositFromProvider(
          Number(dep.id),
          `WinyPay reported ${status || 'failed'}`,
          txnId,
        );
        this.logger.log(`[WinyPay callback] deposit ${dep.id} REJECTED`);
      }
    } catch (e: any) {
      // Lost the race with the duplicate callback → already finalized = OK.
      const [now] = await this.dataSource.query(
        `SELECT status FROM deposits WHERE id = $1`,
        [dep.id],
      );
      if (now && now.status !== 'PENDING') {
        this.logger.log(
          `[WinyPay callback] deposit ${dep.id} finalized concurrently (${now.status}) — idempotent`,
        );
        return { status: 'success' }; // WinyPay requires this exact ack body
      }
      throw e;
    }

    return { status: 'success' }; // WinyPay requires this exact ack body
  }

  private verifySignature(raw: string, signature?: string): boolean {
    if (!signature) return false;
    const secret = this.client.secretKey;
    if (!secret) {
      this.logger.error('[WinyPay] WINYPAY_SECRET_KEY not configured — rejecting callback');
      return false;
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(raw, 'utf8')
      .digest('hex');
    try {
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // WinyPay's current_time format: Y-m-d H:i:s
  private now(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
}
