// src/wallet/wallet.service.ts
//
// Status: complete through Sub-pass 4c (Promotion wire-in)
// Integrations: financial ledger, coin service, turnover service,
//               game validation, promotion engine
import { WalletGateway } from './wallet.gateway';
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import {
  AdminAdjustmentDto,
  AdminDepositDecideDto,
  AdminWithdrawalDecideDto,
  DepositListQuery,
  WithdrawalListQuery,
  DepositRequestDto,
  WithdrawalRequestDto,
} from './dto';
import { generateCode } from 'src/Utils';
import { CoinsService } from 'src/coins/coins.service';
import { TurnoverService } from '../turnover/turnover.service';
import { GameValidationService } from '../game/game-validation.service';
import { PromotionEngineService } from '../promotion/promotion-engine.service';
import { ReferralEngineService } from '../referral/referral-engine.service';
import { phoneMatchForms } from '../common/phone.util';
import { MetaCapiService } from '../meta/meta-capi.service';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private dataSource: DataSource,
    private financialLedger: FinancialLedgerService,
    private coinService: CoinsService,
    private turnoverService: TurnoverService,
    private gameValidation: GameValidationService,
    private promotionEngine: PromotionEngineService,
    private referralEngine: ReferralEngineService,
     @Inject(forwardRef(() => WalletGateway))
    private readonly walletGateway: WalletGateway,
    // Meta conversions. From the @Global MetaModule, so no import cycle.
    private readonly metaCapi: MetaCapiService,
  ) {}

  // ─── Helper: lock wallet row ──────────────────────────────────
  private async getWalletForUpdate(qr: QueryRunner, userId: number) {
    const rows = await qr.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('Wallet not found');
    return rows[0];
  }

  // ─── Helper: banking-side limits for the user's VIP tier ──────
  //   Returns the deposit/withdrawal min/max + daily caps configured on
  //   the user's current tier (vip_level_config). Any column may be NULL,
  //   meaning "no limit for that dimension". Returns null if the user's
  //   tier has no config row (then nothing is enforced).
  private async getTierLimits(qr: QueryRunner, userId: number) {
    const rows = await qr.query(
      `SELECT vc.deposit_min, vc.deposit_max,
              vc.withdrawal_min, vc.withdrawal_max,
              vc.withdrawal_daily_count, vc.withdrawal_daily_max
         FROM users u
         JOIN vip_level_config vc ON vc.level = u.vip_level
        WHERE u.id = $1
        LIMIT 1`,
      [userId],
    );
    return rows.length ? rows[0] : null;
  }

  // ─── Helper: VIP-tier banking toggles ─────────────────────────
  //   Each member group has two master switches (deposit_enabled /
  //   withdrawal_enabled on vip_level_config) plus per-channel toggles
  //   (tier_banks, keyed by gateway NAME). Missing rows default to
  //   enabled, so new tiers/gateways stay open until an admin flips them.
  private async assertTierChannelAllowed(
    qr: QueryRunner,
    userId: number,
    gatewayId: number,
    direction: 'DEPOSIT' | 'WITHDRAWAL',
  ): Promise<void> {
    const col = direction === 'DEPOSIT' ? 'deposit_enabled' : 'withdrawal_enabled';
    const rows = await qr.query(
      `SELECT vlc.${col}                    AS tier_enabled,
              tb.enabled                    AS channel_master,
              tb.${col}                     AS channel_enabled,
              g.name                        AS gateway_name
         FROM users u
         LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
         JOIN payment_gateways g ON g.id = $2
         LEFT JOIN tier_banks tb ON tb.level = u.vip_level AND tb.channel = g.name
        WHERE u.id = $1
        LIMIT 1`,
      [userId, gatewayId],
    );
    if (!rows.length) return; // no user row — later checks will handle it
    const r = rows[0];
    const label = direction === 'DEPOSIT' ? 'Deposits' : 'Withdrawals';

    if (r.tier_enabled === false) {
      throw new ForbiddenException(
        `${label} are currently disabled for your VIP level`,
      );
    }
    if (r.channel_master === false || r.channel_enabled === false) {
      throw new ForbiddenException(
        `${r.gateway_name} ${label.toLowerCase()} are not available for your VIP level`,
      );
    }
  }

  // ─── Shared deposit gate ──────────────────────────────────────
  //   The single source of truth for "is this deposit allowed?".
  //   Runs against the supplied query runner (read-only — no writes)
  //   so it can be used both by the pre-flight validateDeposit() and
  //   inside the requestDeposit() transaction. Throws a descriptive
  //   exception on the first failed rule; returns nothing on success.
  //   Rules: phone verified → gateway active → tier toggles → tier
  //   min/max → promo eligibility (verification, frequency, bounds).
  private async assertDepositGate(
    qr: QueryRunner,
    args: { userId: number; gatewayId: number; amount: number; promotionId?: number },
  ): Promise<void> {
    // Phone verification required to deposit (platform policy). A user must
    // have at least one verified phone number on file.
    const phoneRows = await qr.query(
      `SELECT BOOL_OR(is_verified) AS verified
         FROM user_phone_numbers WHERE user_id = $1`,
      [args.userId],
    );
    if (!phoneRows[0]?.verified) {
      throw new ForbiddenException(
        'Please verify your phone number before depositing',
      );
    }

    // Gateway must exist and be active.
    const gateway = await qr.query(
      `SELECT id FROM payment_gateways WHERE id = $1 AND is_active = true LIMIT 1`,
      [args.gatewayId],
    );
    if (!gateway.length) {
      throw new BadRequestException('Payment gateway not found or inactive');
    }

    // VIP-tier banking toggles: tier master switch + per-channel toggle.
    await this.assertTierChannelAllowed(qr, args.userId, args.gatewayId, 'DEPOSIT');

    // Tier deposit limits (min/max) — enforced only when configured.
    const limits = await this.getTierLimits(qr, args.userId);
    if (limits) {
      const min =
        limits.deposit_min != null ? parseFloat(limits.deposit_min) : null;
      const max =
        limits.deposit_max != null ? parseFloat(limits.deposit_max) : null;
      // A limit of 0 (or null) means "no limit" — only enforce when > 0.
      if (min != null && min > 0 && args.amount < min)
        throw new BadRequestException(`Minimum deposit for your tier is ${min}`);
      if (max != null && max > 0 && args.amount > max)
        throw new BadRequestException(`Maximum deposit for your tier is ${max}`);
    }

    // Promo eligibility (throws on bad promo). Runs the FULL gate — including
    // phone/email/profile verification — so the user is told now (e.g. "Phone
    // verification required for this promotion") instead of the bonus silently
    // vanishing at approval.
    if (args.promotionId) {
      await this.promotionEngine.assertDepositEligible(
        qr,
        args.userId,
        args.promotionId,
        args.amount,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════
  // DEPOSIT: PRE-FLIGHT VALIDATION (no writes, no upload)
  //   Call this the moment the user clicks "Deposit", BEFORE revealing
  //   the agent number. Runs the exact same gate as requestDeposit but
  //   persists nothing, so a player is never shown where to send money
  //   for a deposit that would be rejected. Throws the same error the
  //   real deposit would; returns { valid: true } when it would succeed.
  // ═════════════════════════════════════════════════════════════
  async validateDeposit(args: {
    userId: number;
    gatewayId: number;
    amount: number;
    promotionId?: number;
  }) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect(); // read-only — no transaction needed
    try {
      await this.assertDepositGate(qr, args);
      return { valid: true as const };
    } finally {
      await qr.release();
    }
  }

  /**
   * Resolve the "sender number" a player picked for a deposit.
   *
   * A player may hold up to three numbers, and the deposit form lets them
   * choose which one they paid from — the admin sees it as `player_number`
   * when approving. Selection therefore has to be verified server-side: a
   * client could otherwise submit a number belonging to someone else, or one
   * that does not exist, and the approving admin would have no way to tell.
   *
   * Returns the number AS STORED on the row (not the caller's spelling), or
   * the primary number when nothing was chosen — preserving the previous
   * behaviour for clients that don't send the field.
   */
  private async resolveOwnPhone(
    qr: QueryRunner,
    userId: number,
    picked?: string,
  ): Promise<string | null> {
    const raw = picked?.trim();
    if (!raw) {
      const [primary] = await qr.query(
        `SELECT phone_number FROM user_phone_numbers
          WHERE user_id = $1 AND is_primary = true LIMIT 1`,
        [userId],
      );
      return primary?.phone_number ?? null;
    }

    const forms = phoneMatchForms(raw);
    if (!forms.length) throw new BadRequestException('playerNumber is not a valid phone number');

    const [owned] = await qr.query(
      `SELECT phone_number FROM user_phone_numbers
        WHERE user_id = $1
          AND regexp_replace(phone_number, '\\D', '', 'g') = ANY($2::text[])
        LIMIT 1`,
      [userId, forms],
    );
    if (!owned) {
      throw new BadRequestException(
        'playerNumber must be one of your own registered phone numbers',
      );
    }
    return owned.phone_number;
  }

  // ═════════════════════════════════════════════════════════════
  // DEPOSIT: USER REQUESTS
  //   Re-runs the shared deposit gate inside the transaction (catches
  //   anything that changed since the frontend's pre-flight call), then
  //   creates the deposit row. Fails fast on any failed rule.
  // ═════════════════════════════════════════════════════════════
  async requestDeposit(dto: DepositRequestDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      await this.assertDepositGate(qr, {
        userId:      dto.userId,
        gatewayId:   dto.gatewayId,
        amount:      dto.amount,
        promotionId: dto.promotionId,
      });

      // Which of the player's own numbers they sent the money from. The client
      // picks it from a dropdown, but the choice is re-checked here against
      // user_phone_numbers — otherwise anyone could type a stranger's number
      // and have it shown to the approving admin as the sender. Compared
      // digits-only so "+8801..." and "01..." both match the stored value; the
      // STORED string is the row's own, never the caller's spelling.
      const playerNumber = await this.resolveOwnPhone(
        qr, dto.userId, dto.playerNumber,
      );

      const deposit = await qr.query(
        `INSERT INTO deposits
           (deposit_code, user_id, gateway_id, agent_id, promotion_id,
            amount, transaction_number, player_number, screenshot_url, status,
            requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',NOW(),NOW(),NOW())
         RETURNING id`,
        [
          generateCode('DP'),
          dto.userId,
          dto.gatewayId,
          dto.agentId ?? null,
          dto.promotionId ?? null,
          dto.amount,
          dto.transactionNumber,
          playerNumber,
          dto.screenshotUrl,
        ],
      );
      const depositId = Number(deposit[0].id);

      const wallet = await this.getWalletForUpdate(qr, dto.userId);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);

      // Informational ledger entry — no balance change yet
      await this.financialLedger.write({
        qr,
        walletId: wallet.id,
        userId: dto.userId,
        entryType: 'DEPOSIT_PENDING',
        flow: 'CREDIT',
        amount: dto.amount,
        balanceBefore: bal,
        balanceAfter: bal,
        bonusBefore: bon,
        bonusAfter: bon,
        lockedBefore: lck,
        lockedAfter: lck,
        referenceType: 'DEPOSIT',
        referenceId: depositId,
        status: 'PENDING',
        description: `Deposit submitted. TxnNo: ${dto.transactionNumber}`,
        createdByType: 'USER',
        createdById: dto.userId,
      });

      await qr.commitTransaction();

      // Realtime ping for open admin panels (sound + pending-queue refresh).
      // Fire-and-forget: a socket problem must never fail the request.
      void this.notifyAdminsPendingRequest('DEPOSIT', depositId, dto.userId, dto.amount, dto.gatewayId, dto.transactionNumber);

      return { message: 'Deposit submitted. Awaiting admin approval.', depositId };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // Push 'admin:deposit-pending' / 'admin:withdrawal-pending' to the admins
  // room with enough context for a toast ("DP00340 — arnab123 ৳500 bKash").
  private async notifyAdminsPendingRequest(
    kind: 'DEPOSIT' | 'WITHDRAWAL',
    id: number,
    userId: number,
    amount: number,
    gatewayId: number,
    reference?: string,
  ): Promise<void> {
    try {
      const [info] = await this.dataSource.query(
        `SELECT u.username, u.user_code, g.name AS gateway_name
           FROM users u
           LEFT JOIN payment_gateways g ON g.id = $2
          WHERE u.id = $1`,
        [userId, gatewayId],
      );
      const prefix = kind === 'DEPOSIT' ? 'DP' : 'WD';
      this.walletGateway.pushAdminEvent(
        kind === 'DEPOSIT' ? 'admin:deposit-pending' : 'admin:withdrawal-pending',
        {
          kind,
          id,
          refId: `${prefix}${String(id).padStart(5, '0')}`,
          userId,
          username: info?.username ?? null,
          userCode: info?.user_code ?? null,
          amount,
          gateway: info?.gateway_name ?? null,
          reference: reference ?? null, // deposit trx number / withdrawal receive number
          requestedAt: new Date().toISOString(),
        },
      );
    } catch (e: any) {
      this.logger.warn(`notifyAdminsPendingRequest(${kind} ${id}) failed: ${e.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // DEPOSIT: ADMIN DECIDES
  //   APPROVE branch fires (in order):
  //     1. Wallet credit + ledger
  //     2. Coin award (auto-triggers VIP level-up check inside)
  //     3. Promotion apply (credits bonus, creates turnover req,
  //        inserts claim row, bumps counters) — if promo attached
  //   All atomic in one transaction.
  // ═════════════════════════════════════════════════════════════
  async decideDeposit(dto: AdminDepositDecideDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // FOR UPDATE: the auto-reject watcher can decide a deposit at the same
      // moment an admin clicks Approve. Without the row lock both transactions
      // read PENDING and the second write silently overwrites the first.
      const deps = await qr.query(
        `SELECT * FROM deposits WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [dto.depositId],
      );
      if (!deps.length) throw new NotFoundException('Deposit not found');

      const dep = deps[0];
      if (dep.status !== 'PENDING')
        throw new BadRequestException(`Deposit already ${dep.status}`);

      const wallet = await this.getWalletForUpdate(qr, dep.user_id);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);
      const amt = parseFloat(dep.amount);

      if (dto.action === 'APPROVE') {
        const newBal = bal + amt;

        // Is this the player's first-ever approved deposit? Must be asked
        // BEFORE the status UPDATE below, or this deposit counts itself.
        // Served by idx_deposits_user_decided_approved (migration 2050…).
        const [{ c: priorApproved }] = await qr.query(
          `SELECT COUNT(*)::int AS c FROM deposits
            WHERE user_id = $1 AND status = 'APPROVED'`,
          [dep.user_id],
        );
        const isFtd = Number(priorApproved) === 0;

        await qr.query(
          `UPDATE wallets
           SET balance = $1, total_deposited = total_deposited + $2, updated_at = NOW()
           WHERE id = $3`,
          [newBal, amt, wallet.id],
        );

        await qr.query(
          `UPDATE deposits
           SET status = 'APPROVED', decided_at = NOW(),
               approved_by_admin_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [dto.adminId, dto.depositId],
        );

        await this.financialLedger.write({
          qr,
          walletId: wallet.id,
          userId: dep.user_id,
          entryType: 'DEPOSIT_APPROVED',
          flow: 'CREDIT',
          amount: amt,
          balanceBefore: bal,
          balanceAfter: newBal,
          bonusBefore: bon,
          bonusAfter: bon,
          lockedBefore: lck,
          lockedAfter: lck,
          referenceType: 'DEPOSIT',
          referenceId: dto.depositId,
          status: 'SUCCESS',
          description: 'Deposit approved by admin',
          createdByType: 'ADMIN',
          createdById: dto.adminId ?? undefined,
        });

        // ─── COIN AWARD ────────────────────────────────────────
        // Awards coins per coin_settings rules.
        // VIP level-up check is auto-triggered inside CoinService.
        const coinResult = await this.coinService.awardForDeposit(
          qr,
          dep.user_id,
          amt,
          dto.depositId,
        );

        // ─── PROMOTION APPLICATION ─────────────────────────────
        // If a promo was attached, the engine handles atomically:
        //   1. Credit bonus to wallet (bonus_balance or main balance)
        //   2. Create turnover requirement (bonus + deposit × multiplier)
        //   3. Insert user_promotion_claim row
        //   4. Bump promo counters; auto-deactivate if pool exhausted
        //   5. Write financial_ledger entry for the bonus credit
        let promoResult: any = null;
        if (dep.promotion_id) {
          try {
            promoResult = await this.promotionEngine.apply(
              qr,
              dep.user_id,
              Number(dep.promotion_id),
              {
                kind: 'DEPOSIT',
                depositId: Number(dto.depositId),
                depositAmount: amt,
                adminId: dto.adminId ?? undefined,
              },
            );
          } catch (e: any) {
            // Promo became invalid between request and approval.
            // Common causes: expired, pool exhausted by parallel claim,
            // admin deactivated it, member group changed.
            // Don't fail the deposit — money still credits, bonus is skipped.
            this.logger.warn(
              `Deposit ${dto.depositId}: promo ${dep.promotion_id} apply failed — ${e.message}`,
            );
            promoResult = { skipped: true, reason: e.message };
          }
        } else {
          // ─── DEFAULT DEPOSIT TURNOVER ──────────────────────────
          // No promo attached → still create a default 1× turnover
          // requirement (deposit 1000 → 1000 to wager off before withdrawal).
          // The promo branch above creates its own turnover via the engine.
          await this.turnoverService.createFromDeposit(
            qr,
            dep.user_id,
            Number(dto.depositId),
            amt,
            null,
          );
        }

        // Refer-a-friend deposit progress (referrer + referee sides). Isolated
        // via a SAVEPOINT inside the engine — never breaks the deposit.
        await this.referralEngine.onDeposit(qr, dep.user_id, amt);

        // Meta conversion, queued in THIS transaction so it cannot exist for a
        // deposit that rolls back nor be lost for one that commits. Only
        // players attributed to a campaign with a bound pixel produce a row;
        // the call is a no-op for everyone else and never throws.
        await this.metaCapi.enqueue(qr, {
          eventName: 'Purchase',
          eventId: MetaCapiService.eventIdFor('dep', dto.depositId),
          userId: Number(dep.user_id),
          depositId: Number(dto.depositId),
          value: amt,
          isFtd,
        });

        await qr.commitTransaction();
         await this.walletGateway.pushBalanceUpdate(dep.user_id)
        return {
          message: 'Deposit approved. Wallet credited.',
          newBalance: newBal,
          coinsEarned: coinResult?.awarded ?? 0,
          totalCoins: coinResult?.newTotal ?? null,
          promotion: promoResult,   // null if no promo, {skipped:true} if promo failed
        };
      } else {
        // REJECT — no balance change, just status update
        await qr.query(
          `UPDATE deposits
           SET status = 'REJECTED', decided_at = NOW(),
               approved_by_admin_id = $1, rejection_reason = $2,
               auto_rejected = $3, updated_at = NOW()
           WHERE id = $4`,
          [dto.adminId, dto.rejectionReason ?? null, dto.auto === true, dto.depositId],
        );

        await this.financialLedger.write({
          qr,
          walletId: wallet.id,
          userId: dep.user_id,
          entryType: 'DEPOSIT_REJECTED',
          flow: 'DEBIT',
          amount: amt,
          balanceBefore: bal,
          balanceAfter: bal,
          bonusBefore: bon,
          bonusAfter: bon,
          lockedBefore: lck,
          lockedAfter: lck,
          referenceType: 'DEPOSIT',
          referenceId: dto.depositId,
          status: 'FAILED',
          description: dto.rejectionReason ?? 'Deposit rejected by admin',
          createdByType: dto.auto === true ? 'SYSTEM' : 'ADMIN',
          createdById: dto.adminId ?? undefined,
        });

        await qr.commitTransaction();
        return { message: 'Deposit rejected.' };
      }
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // DEPOSIT: REOPEN AN AUTO-REJECTED REQUEST
  //   Safety valve for the pending-timeout watcher: the player really did
  //   send the money, nobody got to the queue in time. Puts the row back in
  //   the PENDING queue so the normal approve flow can credit it.
  //
  //   Only auto_rejected rows qualify — a rejection a human actually made
  //   (wrong amount, fake screenshot, fraud) stays final.
  //
  //   requested_at is deliberately NOT touched: reports keep the true request
  //   time, and reopened_at is what tells the watcher to leave this one alone
  //   from now on.
  // ═════════════════════════════════════════════════════════════
  async reopenDeposit(depositId: number, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const deps = await qr.query(
        `SELECT id, user_id, status, auto_rejected,
                amount, gateway_id, transaction_number
           FROM deposits WHERE id = $1 LIMIT 1 FOR UPDATE`,
        [depositId],
      );
      if (!deps.length) throw new NotFoundException('Deposit not found');

      const dep = deps[0];
      if (dep.status !== 'REJECTED')
        throw new BadRequestException(
          `Only a rejected deposit can be reopened — this one is ${dep.status}`,
        );
      if (!dep.auto_rejected)
        throw new BadRequestException(
          'This deposit was rejected by an admin, not by the pending timeout. It cannot be reopened.',
        );

      await qr.query(
        `UPDATE deposits
            SET status = 'PENDING', decided_at = NULL,
                approved_by_admin_id = NULL, rejection_reason = NULL,
                auto_rejected = false,
                reopened_at = NOW(), reopened_by_admin_id = $1,
                updated_at = NOW()
          WHERE id = $2`,
        [adminId, depositId],
      );

      // Balance is untouched (the reject never moved money) — this entry only
      // restores the audit trail's "awaiting decision" state.
      const wallet = await this.getWalletForUpdate(qr, dep.user_id);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);

      await this.financialLedger.write({
        qr,
        walletId: wallet.id,
        userId: dep.user_id,
        entryType: 'DEPOSIT_PENDING',
        flow: 'CREDIT',
        amount: parseFloat(dep.amount),   // informational — mirrors the original request entry
        balanceBefore: bal,
        balanceAfter: bal,
        bonusBefore: bon,
        bonusAfter: bon,
        lockedBefore: lck,
        lockedAfter: lck,
        referenceType: 'DEPOSIT',
        referenceId: depositId,
        status: 'PENDING',
        description: 'Auto-rejected deposit reopened by admin',
        createdByType: 'ADMIN',
        createdById: adminId,
      });

      await qr.commitTransaction();

      // Put it back on open admin panels the same way a fresh request lands.
      void this.notifyAdminsPendingRequest(
        'DEPOSIT',
        depositId,
        dep.user_id,
        parseFloat(dep.amount),
        Number(dep.gateway_id),
        dep.transaction_number,
      );

      return { message: 'Deposit reopened. It is back in the pending queue.', depositId };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PROVIDER (PSP) DEPOSITS — e.g. WinyPay automated online deposits
  //   createProviderDeposit  → runs the SAME deposit gate, inserts a PENDING
  //                            `deposits` row tagged with the provider (no
  //                            screenshot/agent), returns the order code.
  //   approve/rejectDepositFromProvider → reuse decideDeposit so the credit
  //                            path (balance, total_deposited, ledger, coins,
  //                            promotion, default turnover, referral) is
  //                            IDENTICAL to an admin approval. adminId=null
  //                            marks it as an automated/system decision.
  // ═════════════════════════════════════════════════════════════
  async createProviderDeposit(dto: {
    userId: number;
    gatewayId: number;
    amount: number;
    payType: string;       // bkash | nagad
    provider: string;      // 'WINYPAY'
    promotionId?: number;
  }): Promise<{ depositId: number; depositCode: string }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.assertDepositGate(qr, {
        userId: dto.userId,
        gatewayId: dto.gatewayId,
        amount: dto.amount,
        promotionId: dto.promotionId,
      });

      const depositCode = generateCode('DEP'); // also serves as the provider order_id
      const deposit = await qr.query(
        `INSERT INTO deposits
           (deposit_code, user_id, gateway_id, agent_id, promotion_id,
            amount, transaction_number, screenshot_url, status,
            provider, pay_type, requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,'','PENDING',$7,$8,NOW(),NOW(),NOW())
         RETURNING id`,
        [
          depositCode, dto.userId, dto.gatewayId, dto.promotionId ?? null,
          dto.amount, depositCode /* transaction_number = order_id */,
          dto.provider, dto.payType,
        ],
      );
      const depositId = Number(deposit[0].id);

      const wallet = await this.getWalletForUpdate(qr, dto.userId);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);

      await this.financialLedger.write({
        qr,
        walletId: wallet.id,
        userId: dto.userId,
        entryType: 'DEPOSIT_PENDING',
        flow: 'CREDIT',
        amount: dto.amount,
        balanceBefore: bal,
        balanceAfter: bal,
        bonusBefore: bon,
        bonusAfter: bon,
        lockedBefore: lck,
        lockedAfter: lck,
        referenceType: 'DEPOSIT',
        referenceId: depositId,
        status: 'PENDING',
        description: `${dto.provider} deposit initiated (${dto.payType}). Order: ${depositCode}`,
        createdByType: 'USER',
        createdById: dto.userId,
      });

      await qr.commitTransaction();
      return { depositId, depositCode };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async approveDepositFromProvider(depositId: number, providerTxnId?: string) {
    if (providerTxnId) {
      await this.dataSource.query(
        `UPDATE deposits SET provider_txn_id = $1, updated_at = NOW() WHERE id = $2`,
        [providerTxnId, depositId],
      );
    }
    return this.decideDeposit({ depositId, adminId: null, action: 'APPROVE' });
  }

  async rejectDepositFromProvider(depositId: number, reason: string, providerTxnId?: string) {
    if (providerTxnId) {
      await this.dataSource.query(
        `UPDATE deposits SET provider_txn_id = $1, updated_at = NOW() WHERE id = $2`,
        [providerTxnId, depositId],
      );
    }
    return this.decideDeposit({
      depositId,
      adminId: null,
      action: 'REJECT',
      rejectionReason: reason,
    });
  }

  // ═════════════════════════════════════════════════════════════
  // WITHDRAWAL: USER REQUESTS
  //   Validation order (fail fast):
  //     1. User account active
  //     2. Gateway exists + active
  //     3. No pending bets (game settlement guard)
  //     4. No active turnover requirements
  //     5. Sufficient balance
  //   Then locks the requested amount and creates withdrawal row.
  // ═════════════════════════════════════════════════════════════
  async requestWithdrawal(dto: WithdrawalRequestDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const user = await qr.query(
        `SELECT id, account_status FROM users WHERE id = $1 LIMIT 1`,
        [dto.userId],
      );
      if (!user.length) throw new NotFoundException('User not found');
      if (user[0].account_status !== 'ACTIVE')
        throw new ForbiddenException(`Account is ${user[0].account_status}`);

      const gateway = await qr.query(
        `SELECT id FROM payment_gateways WHERE id = $1 AND is_active = true LIMIT 1`,
        [dto.gatewayId],
      );
      if (!gateway.length)
        throw new BadRequestException('Payment gateway not found or inactive');

      // VIP-tier banking toggles: tier master switch + per-channel toggle.
      await this.assertTierChannelAllowed(qr, dto.userId, dto.gatewayId, 'WITHDRAWAL');

      // Must have funded the account at least once before withdrawing.
      // Blocks no-deposit bonus/winnings extraction. total_deposited is
      // bumped on every approved deposit + manual deposit, so a lifetime
      // value of 0 means the user has never put money in.
      const funded = await qr.query(
        `SELECT total_deposited FROM wallets WHERE user_id = $1 LIMIT 1`,
        [dto.userId],
      );
      if (!funded.length || parseFloat(funded[0].total_deposited) <= 0)
        throw new ForbiddenException(
          'You must make at least one deposit before you can withdraw.',
        );

      // Receive number must be a VERIFIED phone number on this account.
      // Stored numbers come in mixed formats (+8801…, 01…, 8801…), so both
      // sides are normalised to the bare subscriber digits before matching:
      // strip non-digits, then drop a leading 880 (country code) and/or 0.
      const phoneMatch = await qr.query(
        `SELECT BOOL_OR(is_verified) AS any_verified
           FROM user_phone_numbers
          WHERE user_id = $1
            AND regexp_replace(regexp_replace(phone_number, '[^0-9]', '', 'g'), '^(880)?0?', '')
              = regexp_replace(regexp_replace($2,           '[^0-9]', '', 'g'), '^(880)?0?', '')`,
        [dto.userId, dto.receiveNumber],
      );
      const matchedVerified = phoneMatch[0]?.any_verified;
      if (matchedVerified === null || matchedVerified === undefined)
        throw new ForbiddenException(
          'Withdrawals are only allowed to a phone number registered on your account.',
        );
      if (matchedVerified !== true)
        throw new ForbiddenException(
          'The withdrawal number must be a verified number on your account.',
        );

      // Tier withdrawal limits (min/max + daily caps) — enforced only when configured.
      const limits = await this.getTierLimits(qr, dto.userId);
      if (limits) {
        const wmin =
          limits.withdrawal_min != null
            ? parseFloat(limits.withdrawal_min)
            : null;
        const wmax =
          limits.withdrawal_max != null
            ? parseFloat(limits.withdrawal_max)
            : null;
        // A limit of 0 (or null) means "no limit" — only enforce when > 0.
        if (wmin != null && wmin > 0 && dto.amount < wmin)
          throw new BadRequestException(
            `Minimum withdrawal for your tier is ${wmin}`,
          );
        if (wmax != null && wmax > 0 && dto.amount > wmax)
          throw new BadRequestException(
            `Maximum withdrawal for your tier is ${wmax}`,
          );

        const dailyCountLimit =
          limits.withdrawal_daily_count != null
            ? Number(limits.withdrawal_daily_count)
            : null;
        const dailyMaxLimit =
          limits.withdrawal_daily_max != null
            ? parseFloat(limits.withdrawal_daily_max)
            : null;
        if (dailyCountLimit != null || dailyMaxLimit != null) {
          // Count today's non-rejected withdrawals (PENDING + APPROVED both
          // consume the daily allowance; rejected ones are released).
          const todays = await qr.query(
            `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0) AS total
               FROM withdrawals
              WHERE user_id = $1
                AND status <> 'REJECTED'
                AND requested_at::date = CURRENT_DATE`,
            [dto.userId],
          );
          const cnt = Number(todays[0].cnt);
          const total = parseFloat(todays[0].total);
          if (dailyCountLimit != null && cnt >= dailyCountLimit)
            throw new BadRequestException(
              `Daily withdrawal limit reached (${dailyCountLimit} per day for your tier)`,
            );
          if (dailyMaxLimit != null && total + dto.amount > dailyMaxLimit)
            throw new BadRequestException(
              `Daily withdrawal amount limit for your tier is ${dailyMaxLimit}. ` +
                `Already withdrawn today: ${total}`,
            );
        }
      }

      // No unsettled bets allowed (strict rule)
      await this.gameValidation.ensureNoPendingBets(qr, dto.userId);

      // No active turnover requirements (only matters for users who
      // claimed promos — silent no-op for everyone else)
      await this.turnoverService.ensureNoActiveReqs(qr, dto.userId);

      const wallet = await this.getWalletForUpdate(qr, dto.userId);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);

      if (bal < dto.amount)
        throw new BadRequestException(`Insufficient balance. Available: ${bal}`);

      const newBal = bal - dto.amount;
      const newLck = lck + dto.amount;

      await qr.query(
        `UPDATE wallets
         SET balance = $1, locked_balance = $2, updated_at = NOW()
         WHERE id = $3`,
        [newBal, newLck, wallet.id],
      );

      const withdrawal = await qr.query(
        `INSERT INTO withdrawals
           (withdrawal_code, user_id, gateway_id, amount, receive_number,
            status, requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'PENDING',NOW(),NOW(),NOW())
         RETURNING id`,
        [
          generateCode('WD'),
          dto.userId,
          dto.gatewayId,
          dto.amount,
          dto.receiveNumber,
        ],
      );
      const withdrawalId = Number(withdrawal[0].id);

      await this.financialLedger.write({
        qr,
        walletId: wallet.id,
        userId: dto.userId,
        entryType: 'WITHDRAWAL_REQUESTED',
        flow: 'LOCK',
        amount: dto.amount,
        balanceBefore: bal,
        balanceAfter: newBal,
        bonusBefore: bon,
        bonusAfter: bon,
        lockedBefore: lck,
        lockedAfter: newLck,
        referenceType: 'WITHDRAWAL',
        referenceId: withdrawalId,
        status: 'PENDING',
        description: `Withdrawal requested to ${dto.receiveNumber}`,
        createdByType: 'USER',
        createdById: dto.userId,
      });

      await qr.commitTransaction();

      // Realtime ping for open admin panels (sound + pending-queue refresh).
      void this.notifyAdminsPendingRequest('WITHDRAWAL', withdrawalId, dto.userId, dto.amount, dto.gatewayId, dto.receiveNumber);

      return {
        message: 'Withdrawal requested. Awaiting admin approval.',
        withdrawalId,
        availableBalance: newBal,
        lockedBalance: newLck,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // WITHDRAWAL: ADMIN DECIDES
  //   APPROVE: locked amount → counted as withdrawn,
  //            all turnover reqs reset to ARCHIVED.
  //   REJECT:  locked amount → refunded back to balance.
  // ═════════════════════════════════════════════════════════════
  async decideWithdrawal(dto: AdminWithdrawalDecideDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const wdrs = await qr.query(
        `SELECT * FROM withdrawals WHERE id = $1 LIMIT 1`,
        [dto.withdrawalId],
      );
      if (!wdrs.length) throw new NotFoundException('Withdrawal not found');

      const wdr = wdrs[0];
      if (wdr.status !== 'PENDING')
        throw new BadRequestException(`Withdrawal already ${wdr.status}`);

      const wallet = await this.getWalletForUpdate(qr, wdr.user_id);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);
      const amt = parseFloat(wdr.amount);

      if (dto.action === 'APPROVE') {
        const newLck = lck - amt;

        await qr.query(
          `UPDATE wallets
           SET locked_balance = $1, total_withdrawn = total_withdrawn + $2, updated_at = NOW()
           WHERE id = $3`,
          [newLck, amt, wallet.id],
        );

        await qr.query(
          `UPDATE withdrawals
           SET status = 'APPROVED', decided_at = NOW(),
               approved_by_admin_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [dto.adminId, dto.withdrawalId],
        );

        await this.financialLedger.write({
          qr,
          walletId: wallet.id,
          userId: wdr.user_id,
          entryType: 'WITHDRAWAL_APPROVED',
          flow: 'RELEASE',
          amount: amt,
          balanceBefore: bal,
          balanceAfter: bal,
          bonusBefore: bon,
          bonusAfter: bon,
          lockedBefore: lck,
          lockedAfter: newLck,
          referenceType: 'WITHDRAWAL',
          referenceId: dto.withdrawalId,
          status: 'SUCCESS',
          description: 'Withdrawal approved by admin',
          createdByType: 'ADMIN',
          createdById: dto.adminId ?? undefined,
        });

        // Reset all turnover progress on approved withdrawal.
        // (Per design: clean slate after every successful withdrawal)
        await this.turnoverService.resetAllActive(
          qr,
          wdr.user_id,
          dto.withdrawalId,
        );

        await qr.commitTransaction();
        return { message: 'Withdrawal approved.' };
      } else {
        // REJECT — refund locked back to balance
        const newBal = bal + amt;
        const newLck = lck - amt;

        await qr.query(
          `UPDATE wallets
           SET balance = $1, locked_balance = $2, updated_at = NOW()
           WHERE id = $3`,
          [newBal, newLck, wallet.id],
        );

        await qr.query(
          `UPDATE withdrawals
           SET status = 'REJECTED', decided_at = NOW(),
               approved_by_admin_id = $1, rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [dto.adminId, dto.rejectionReason ?? null, dto.withdrawalId],
        );

        await this.financialLedger.write({
          qr,
          walletId: wallet.id,
          userId: wdr.user_id,
          entryType: 'WITHDRAWAL_REJECTED',
          flow: 'RELEASE',
          amount: amt,
          balanceBefore: bal,
          balanceAfter: newBal,
          bonusBefore: bon,
          bonusAfter: bon,
          lockedBefore: lck,
          lockedAfter: newLck,
          referenceType: 'WITHDRAWAL',
          referenceId: dto.withdrawalId,
          status: 'FAILED',
          description: dto.rejectionReason ?? 'Withdrawal rejected. Amount refunded.',
          createdByType: 'ADMIN',
          createdById: dto.adminId ?? undefined,
        });

        await qr.commitTransaction();
        await this.walletGateway.pushBalanceUpdate(wdr.user_id);
        return { message: 'Withdrawal rejected. Balance refunded.', newBalance: newBal };
      }
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: MANUAL WALLET ADJUSTMENT
  //   Signed amount: + credit, - debit.
  //   Refuses if it would push balance negative.
  // ═════════════════════════════════════════════════════════════
   async adminAdjustWallet(dto: AdminAdjustmentDto) {
  if (!Number.isFinite(dto.amount))
    throw new BadRequestException('Adjustment amount must be a valid number');
  if (dto.amount === 0)
    throw new BadRequestException('Adjustment amount cannot be zero');
  if (!Number.isInteger(dto.userId))
    throw new BadRequestException('userId must be a valid id');

  // Validate adjustmentType
  if (!['MANUAL_ADJUSTMENT', 'MANUAL_DEPOSIT'].includes(dto.adjustmentType))
    throw new BadRequestException('Invalid adjustment type');

  // Turnover multiplier is credit-only and must be a non-negative number.
  const turnoverMultiplier = dto.turnoverMultiplier ?? 0;
  if (!Number.isFinite(turnoverMultiplier) || turnoverMultiplier < 0)
    throw new BadRequestException('turnoverMultiplier must be 0 or greater');

  const qr = this.dataSource.createQueryRunner();
  await qr.connect();
  await qr.startTransaction();

  try {
    const wallet = await this.getWalletForUpdate(qr, dto.userId);
    const bal = parseFloat(wallet.balance);
    const bon = parseFloat(wallet.bonus_balance);
    const lck = parseFloat(wallet.locked_balance);
    const newBal = bal + dto.amount;

    if (newBal < 0)
      throw new BadRequestException(`Adjustment results in negative balance (${newBal})`);

    await qr.query(
      `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBal, wallet.id],
    );

    // If it's a manual deposit, also bump total_deposited
    if (dto.adjustmentType === 'MANUAL_DEPOSIT' && dto.amount > 0) {
      await qr.query(
        `UPDATE wallets
         SET total_deposited = total_deposited + $1, updated_at = NOW()
         WHERE id = $2`,
        [dto.amount, wallet.id],
      );
    }

    const adj = await qr.query(
      `INSERT INTO manual_adjustments (admin_id, user_id, amount, description, created_at)
       VALUES ($1,$2,$3,$4,NOW())
       RETURNING id`,
      [dto.adminId, dto.userId, dto.amount, dto.description],
    );

    await this.financialLedger.write({
      qr,
      walletId:      wallet.id,
      userId:        dto.userId,
      entryType:     dto.adjustmentType,   // ← 'MANUAL_ADJUSTMENT' or 'MANUAL_DEPOSIT'
      flow:          dto.amount > 0 ? 'CREDIT' : 'DEBIT',
      amount:        Math.abs(dto.amount),
      balanceBefore: bal,
      balanceAfter:  newBal,
      bonusBefore:   bon,
      bonusAfter:    bon,
      lockedBefore:  lck,
      lockedAfter:   lck,
      // reference_type names the linked table (always a manual_adjustments
      // row); the deposit-vs-adjustment distinction lives in entry_type.
      // 'MANUAL_DEPOSIT' is NOT a valid reference_type per the DB check.
      referenceType: 'MANUAL_ADJUSTMENT',
      referenceId:   Number(adj[0].id),
      status:        'SUCCESS',
      description:   dto.description,
      meta:          dto.meta,
      createdByType: 'ADMIN',
      createdById:   dto.adminId,
    });

    // ─── TURNOVER ON CREDIT ──────────────────────────────────────
    // A credit adjustment (e.g. "Weekly Loss Bonus") can carry a wagering
    // requirement: amount × multiplier. Debits never create turnover — they
    // just appear in the transaction history. The description becomes the
    // requirement's header on the user's wagering page.
    //
    // multiplier 0 still creates a row, with target 0 and status COMPLETED, so
    // the credit is VISIBLE on the wagering and admin turnover pages as an
    // adjustment that required no wagering. Skipping the insert entirely made
    // a 0× adjustment invisible there — indistinguishable from one that was
    // never granted — which is exactly the audit trail those pages exist for.
    // It imposes no obligation: insertRequirement stores a zero-target row as
    // COMPLETED, so it never gates a withdrawal.
    let turnover: { requirementId: number; targetAmount: number } | null = null;
    if (dto.amount > 0) {
      turnover = await this.turnoverService.insertRequirement(qr, {
        userId:     dto.userId,
        sourceType: 'MANUAL',
        sourceId:   Number(adj[0].id),
        baseAmount: dto.amount,
        multiplier: turnoverMultiplier,
        targetAmount: dto.amount * turnoverMultiplier,
        adminId:    dto.adminId,
        label:      dto.description,
      });
    }

    await qr.commitTransaction();
    await this.walletGateway.pushBalanceUpdate(dto.userId);
    return {
      message: 'Wallet adjusted.',
      balanceBefore: bal,
      balanceAfter: newBal,
      turnover, // null when none created (debit, or multiplier 0)
    };
  } catch (e) {
    await qr.rollbackTransaction();
    throw e;
  } finally {
    await qr.release();
  }
}

  // ═════════════════════════════════════════════════════════════
  // ADMIN: MANUAL DEPOSIT
  //   Creates a REAL deposits row (already APPROVED) and runs the same
  //   side-effects as an ordinary approval: wallet credit, total_deposited,
  //   coins, promotion bonus, turnover requirement, refer-a-friend progress.
  //   So the deposit shows on the deposit list (with DP id, gateway, TRX,
  //   promotion) and in transaction history as "MANUAL DEPOSIT".
  // ═════════════════════════════════════════════════════════════
  async adminManualDeposit(dto: {
    adminId: number;
    usernameOrPhone: string;
    amount: number;
    gatewayId: number;          // the "Wallet" dropdown (bKash / Nagad / …)
    playerNumber?: string;      // player's cashout (sender) number
    trxNumber?: string;         // gateway TRX id, as reported by the player
    promotionId?: number;       // optional promo — applied like a real deposit
    turnoverMultiplier?: number; // omit = default 1× (like normal deposits),
                                 // 0 = no requirement; ignored when promo set
    description?: string;
  }) {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0)
      throw new BadRequestException('amount must be a positive number');
    if (!dto.usernameOrPhone?.trim())
      throw new BadRequestException('usernameOrPhone is required');
    if (!Number.isInteger(dto.gatewayId))
      throw new BadRequestException('gatewayId is required (the wallet/channel)');
    if (dto.turnoverMultiplier !== undefined &&
        (!Number.isFinite(dto.turnoverMultiplier) || dto.turnoverMultiplier < 0))
      throw new BadRequestException('turnoverMultiplier must be 0 or greater');

    // Resolve the player: exact username → phone number digits → numeric id.
    const term = dto.usernameOrPhone.trim();
    const digits = term.replace(/\D/g, '');
    const users = await this.dataSource.query(
      `SELECT u.id, u.username FROM users u
        WHERE LOWER(u.username) = LOWER($1)
           OR ($2 <> '' AND EXISTS (
                SELECT 1 FROM user_phone_numbers up
                 WHERE up.user_id = u.id
                   AND regexp_replace(up.phone_number, '\\D', '', 'g') LIKE '%' || $2))
           OR ($3 AND u.id = $4)
        LIMIT 2`,
      [term, digits.length >= 6 ? digits : '', /^\d+$/.test(term), /^\d+$/.test(term) ? Number(term) : 0],
    );
    if (!users.length) throw new NotFoundException(`No user matches "${term}"`);
    if (users.length > 1)
      throw new BadRequestException(`"${term}" matches more than one user — use the exact username or user id`);
    const userId = Number(users[0].id);

    const gws = await this.dataSource.query(
      `SELECT id, name FROM payment_gateways WHERE id = $1 LIMIT 1`,
      [dto.gatewayId],
    );
    if (!gws.length) throw new NotFoundException('Gateway (wallet) not found');
    const gateway = gws[0];

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const depositCode = generateCode('DP');
      const dep = await qr.query(
        `INSERT INTO deposits
           (deposit_code, user_id, gateway_id, agent_id, promotion_id,
            amount, transaction_number, player_number, screenshot_url,
            status, requested_at, decided_at, approved_by_admin_id,
            created_at, updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,'','APPROVED',NOW(),NOW(),$8,NOW(),NOW())
         RETURNING id`,
        [
          depositCode,
          userId,
          dto.gatewayId,
          dto.promotionId ?? null,
          dto.amount,
          dto.trxNumber?.trim() || depositCode,
          dto.playerNumber?.trim() || null,
          dto.adminId,
        ],
      );
      const depositId = Number(dep[0].id);

      const wallet = await this.getWalletForUpdate(qr, userId);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);
      const newBal = bal + dto.amount;

      await qr.query(
        `UPDATE wallets
         SET balance = $1, total_deposited = total_deposited + $2, updated_at = NOW()
         WHERE id = $3`,
        [newBal, dto.amount, wallet.id],
      );

      await this.financialLedger.write({
        qr,
        walletId:      wallet.id,
        userId,
        entryType:     'MANUAL_DEPOSIT',
        flow:          'CREDIT',
        amount:        dto.amount,
        balanceBefore: bal,
        balanceAfter:  newBal,
        bonusBefore:   bon,
        bonusAfter:    bon,
        lockedBefore:  lck,
        lockedAfter:   lck,
        // Reference the deposits row so the transaction statement resolves
        // DP id / gateway / TRX exactly like player-initiated deposits.
        referenceType: 'DEPOSIT',
        referenceId:   depositId,
        status:        'SUCCESS',
        description:   dto.description ?? `Manual deposit via ${gateway.name} by admin`,
        createdByType: 'ADMIN',
        createdById:   dto.adminId,
      });

      const coinResult = await this.coinService.awardForDeposit(
        qr, userId, dto.amount, depositId,
      );

      // Promotion — admin picked it deliberately, so unlike deposit approval
      // (which skips a stale promo) any failure here fails the whole call.
      let promoResult: any = null;
      let turnover: { requirementId: number; targetAmount: number } | null = null;
      if (dto.promotionId) {
        try {
          promoResult = await this.promotionEngine.apply(qr, userId, Number(dto.promotionId), {
            kind: 'DEPOSIT',
            depositId,
            depositAmount: dto.amount,
            adminId: dto.adminId,
          });
        } catch (e: any) {
          throw new BadRequestException(`Promotion could not be applied: ${e.message}`);
        }
      } else if (dto.turnoverMultiplier === undefined) {
        // No promo, no explicit multiplier → same default 1× as a normal deposit.
        await this.turnoverService.createFromDeposit(qr, userId, depositId, dto.amount, null);
      } else if (dto.turnoverMultiplier > 0) {
        turnover = await this.turnoverService.insertRequirement(qr, {
          userId,
          sourceType: 'MANUAL',
          sourceId:   depositId,
          baseAmount: dto.amount,
          multiplier: dto.turnoverMultiplier,
          targetAmount: dto.amount * dto.turnoverMultiplier,
          adminId:    dto.adminId,
          label:      dto.description ?? `Manual deposit via ${gateway.name}`,
        });
      } // multiplier 0 → no requirement

      await this.referralEngine.onDeposit(qr, userId, dto.amount);

      await qr.commitTransaction();
      await this.walletGateway.pushBalanceUpdate(userId);
      return {
        message: 'Manual deposit credited.',
        depositId,
        dpId: `DP${String(depositId).padStart(5, '0')}`,
        userId,
        username: users[0].username,
        gateway: gateway.name,
        trxNumber: dto.trxNumber?.trim() || depositCode,
        amount: dto.amount,
        newBalance: newBal,
        coinsEarned: coinResult?.awarded ?? 0,
        promotion: promoResult,
        turnover,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // Wallet dropdown for the manual-deposit form (and anywhere else the
  // admin panel needs the raw channel list).
  async listGatewaysAdmin() {
    return this.dataSource.query(
      `SELECT id, name, is_active FROM payment_gateways ORDER BY id ASC`,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST PENDING DEPOSITS (with agent + promo info)
  // ═════════════════════════════════════════════════════════════
async getPendingDeposits(q: DepositListQuery = {}) {
    const status    = q.status   ?? 'PENDING';
    const page      = Math.max(q.page  ?? 1, 1);
    const limit     = Math.min(q.limit ?? 20, 100);
    const offset    = (page - 1) * limit;
 
    const where: string[] = [];
    const params: any[]   = [];
    let i = 1;
 
    // Status filter — 'ALL' skips the status WHERE clause
    if (status !== 'ALL') {
      where.push(`d.status = $${i++}`);
      params.push(status);
    }
 
    // Search — matches deposit_code, transaction_number, username, full_name,
    //          date in YYYY-MM-DD or DD-MM-YYYY format
    if (q.search?.trim()) {
      const term = `%${q.search.trim()}%`;
      where.push(
        `(d.deposit_code ILIKE $${i}
          OR d.transaction_number ILIKE $${i}
          OR u.username ILIKE $${i}
          OR u.full_name ILIKE $${i}
          OR TO_CHAR(d.requested_at, 'YYYY-MM-DD') ILIKE $${i}
          OR TO_CHAR(d.requested_at, 'DD-MM-YYYY') ILIKE $${i})`,
      );
      params.push(term);
      i++;
    }
 
    // Gateway filter
    if (q.gatewayId) {
      where.push(`d.gateway_id = $${i++}`);
      params.push(q.gatewayId);
    }

    // Provider filter — e.g. ?provider=WINYPAY (automated), or ?provider=MANUAL
    // for agent deposits (provider IS NULL).
    if (q.provider?.trim()) {
      const prov = q.provider.trim().toUpperCase();
      if (prov === 'MANUAL' || prov === 'NONE') {
        where.push(`d.provider IS NULL`);
      } else {
        where.push(`d.provider = $${i++}`);
        params.push(prov);
      }
    }

    // Single user filter (admin viewing one user's deposits)
    if (q.userId) {
      where.push(`d.user_id = $${i++}`);
      params.push(q.userId);
    }

    // Date range on requested_at
    if (q.dateFrom) {
      where.push(`d.requested_at >= $${i++}::date`);
      params.push(q.dateFrom);
    }
    if (q.dateTo) {
      where.push(`d.requested_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.dateTo);
    }

    // Member Group = VIP tier name (same convention as member search)
    if (q.memberGroup?.trim()) {
      where.push(`(vlc.group_name ILIKE $${i} OR vlc.level_name ILIKE $${i})`);
      params.push(q.memberGroup.trim());
      i++;
    }

    // Member ID = users.user_code
    if (q.memberId?.trim()) {
      where.push(`u.user_code ILIKE $${i++}`);
      params.push(`%${q.memberId.trim()}%`);
    }

    // Player phone — compare digits only, so +8801302…, 8801302… and
    // 01302… all hit the same stored number (any of the user's numbers).
    if (q.phone?.trim()) {
      const digits = q.phone.replace(/\D/g, '').replace(/^880/, '').replace(/^0/, '');
      where.push(`EXISTS (
        SELECT 1 FROM user_phone_numbers up
         WHERE up.user_id = u.id
           AND regexp_replace(up.phone_number, '\\D', '', 'g') LIKE $${i++})`);
      params.push(`%${digits}%`);
    }

    // TRX ID the player entered
    if (q.trxId?.trim()) {
      where.push(`d.transaction_number ILIKE $${i++}`);
      params.push(`%${q.trxId.trim()}%`);
    }

    // DP ID — "DP00123" (or bare digits) → deposits.id
    if (q.dpId?.trim()) {
      const idDigits = q.dpId.replace(/\D/g, '');
      where.push(`d.id = $${i++}`);
      params.push(idDigits ? parseInt(idDigits, 10) : -1);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT
         d.id,
         'DP' || LPAD(d.id::text, 5, '0') AS dp_id,
         d.deposit_code,
         d.user_id,
         d.amount,
         d.status,
         d.transaction_number,
         d.screenshot_url,
         d.requested_at,
         d.decided_at,
         d.rejection_reason,
         d.auto_rejected,   -- true = rejected by the pending-timeout watcher
         d.reopened_at,
         d.promotion_id,
         d.provider,
         d.pay_type,
         d.provider_txn_id,
         -- User info
         u.full_name,
         u.username,
         u.email,
         u.user_code                                    AS member_id,
         u.vip_level,
         COALESCE(vlc.group_name, vlc.level_name)       AS vip_level_name,
         -- Cashout number typed on the manual-deposit form wins; otherwise
         -- the player's primary phone number.
         COALESCE(d.player_number, ph.phone_number)     AS player_number,
         -- Deposits are always player-initiated (no admin-created flow)
         u.username                                     AS created_by,
         -- Bonus: real claim once approved; engine-math preview while pending
         bx.bonus_amount,
         (cl.claimed_bonus IS NULL
          AND d.status = 'PENDING'
          AND d.promotion_id IS NOT NULL)               AS bonus_is_preview,
         (d.amount + bx.bonus_amount)::numeric(18,2)    AS total_amount,
         -- Gateway
         g.id   AS gateway_id,
         g.name AS gateway_name,
         -- Agent (where user sent money)
         a.id           AS agent_id,
         a.agent_number,
         a.agent_code,
         a.wallet_type,
         -- Promotion (if attached)
         p.title AS promotion_title,
         p.code  AS promotion_code,
         p.kind  AS promotion_kind,
         -- Approving admin
         adm.name  AS decided_by_name,
         adm.email AS decided_by_email
       FROM deposits d
       JOIN users u           ON u.id   = d.user_id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       JOIN payment_gateways g ON g.id  = d.gateway_id
       LEFT JOIN agents a      ON a.id  = d.agent_id
       LEFT JOIN promotions p  ON p.id  = d.promotion_id
       LEFT JOIN admin_users adm ON adm.id = d.approved_by_admin_id
       LEFT JOIN LATERAL (
         SELECT up.phone_number
           FROM user_phone_numbers up
          WHERE up.user_id = u.id
          ORDER BY up.is_primary DESC, up.id ASC
          LIMIT 1
       ) ph ON TRUE
       LEFT JOIN LATERAL (
         SELECT c.bonus_amount AS claimed_bonus
           FROM user_promotion_claims c
          WHERE c.deposit_id = d.id AND c.status <> 'CANCELLED'
          ORDER BY c.id DESC
          LIMIT 1
       ) cl ON TRUE
       LEFT JOIN LATERAL (
         SELECT (CASE
                  WHEN cl.claimed_bonus IS NOT NULL THEN cl.claimed_bonus
                  -- Preview mirrors PromotionEngine.computeBonus: PERCENT is
                  -- floored to 2 decimals, then capped by max_bonus.
                  WHEN d.status = 'PENDING' AND p.id IS NOT NULL THEN
                    LEAST(
                      CASE WHEN p.bonus_type = 'PERCENT'
                           THEN FLOOR(d.amount * p.bonus_value) / 100
                           ELSE p.bonus_value::numeric END,
                      p.max_bonus::numeric)
                  ELSE 0
                END)::numeric(18,2) AS bonus_amount
       ) bx ON TRUE
       ${whereSql}
       ORDER BY d.requested_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       ${whereSql}`,
      params,
    );

    return {
      data:  rows,
      total: countRows[0].total,
      page,
      limit,
      filters: {
        status,
        search:      q.search      ?? null,
        gatewayId:   q.gatewayId   ?? null,
        provider:    q.provider    ?? null,
        userId:      q.userId      ?? null,
        dateFrom:    q.dateFrom    ?? null,
        dateTo:      q.dateTo      ?? null,
        memberGroup: q.memberGroup ?? null,
        memberId:    q.memberId    ?? null,
        phone:       q.phone       ?? null,
        trxId:       q.trxId       ?? null,
        dpId:        q.dpId        ?? null,
      },
    };
  }
 
  // ─── ADD getDepositById() ────────────────────────────────────
  async getDepositById(depositId: number) {
    const rows = await this.dataSource.query(
      `SELECT
         d.*,
         'DP' || LPAD(d.id::text, 5, '0') AS dp_id,
         u.full_name, u.username, u.email,
         u.user_code                              AS member_id,
         u.vip_level,
         COALESCE(vlc.group_name, vlc.level_name) AS vip_level_name,
         COALESCE(d.player_number, ph.phone_number) AS player_number,
         u.username                               AS created_by,
         bx.bonus_amount,
         (cl.claimed_bonus IS NULL
          AND d.status = 'PENDING'
          AND d.promotion_id IS NOT NULL)         AS bonus_is_preview,
         (d.amount + bx.bonus_amount)::numeric(18,2) AS total_amount,
         g.name AS gateway_name,
         a.agent_number, a.agent_code, a.wallet_type,
         p.title AS promotion_title, p.code AS promotion_code,
         adm.name AS decided_by_name
       FROM deposits d
       JOIN users u            ON u.id  = d.user_id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       JOIN payment_gateways g ON g.id  = d.gateway_id
       LEFT JOIN agents a      ON a.id  = d.agent_id
       LEFT JOIN promotions p  ON p.id  = d.promotion_id
       LEFT JOIN admin_users adm ON adm.id = d.approved_by_admin_id
       LEFT JOIN LATERAL (
         SELECT up.phone_number
           FROM user_phone_numbers up
          WHERE up.user_id = u.id
          ORDER BY up.is_primary DESC, up.id ASC
          LIMIT 1
       ) ph ON TRUE
       LEFT JOIN LATERAL (
         SELECT c.bonus_amount AS claimed_bonus
           FROM user_promotion_claims c
          WHERE c.deposit_id = d.id AND c.status <> 'CANCELLED'
          ORDER BY c.id DESC
          LIMIT 1
       ) cl ON TRUE
       LEFT JOIN LATERAL (
         SELECT (CASE
                  WHEN cl.claimed_bonus IS NOT NULL THEN cl.claimed_bonus
                  WHEN d.status = 'PENDING' AND p.id IS NOT NULL THEN
                    LEAST(
                      CASE WHEN p.bonus_type = 'PERCENT'
                           THEN FLOOR(d.amount * p.bonus_value) / 100
                           ELSE p.bonus_value::numeric END,
                      p.max_bonus::numeric)
                  ELSE 0
                END)::numeric(18,2) AS bonus_amount
       ) bx ON TRUE
       WHERE d.id = $1`,
      [depositId],
    );
    if (!rows.length) throw new NotFoundException('Deposit not found');
    return rows[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST WITHDRAWALS (status = PENDING | APPROVED | REJECTED | ALL)
  // ═════════════════════════════════════════════════════════════
  // Same multi-field search panel as getPendingDeposits — one endpoint backs
  // the Withdraw page tabs + filters. wd_id is derived (WD00212 = id 212, not
  // stored); "TRX ID" = withdrawal_code; no fee columns exist, so
  // total_amount = amount.
  async getPendingWithdrawals(q: WithdrawalListQuery = {}) {
    const page   = q.page  && q.page  > 0 ? q.page  : 1;
    const limit  = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 20;
    const offset = (page - 1) * limit;
    const status = q.status ?? 'PENDING';

    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (status !== 'ALL') {
      where.push(`w.status = $${i++}`);
      params.push(status);
    }

    // Free-text search (legacy) — code, receive number, name, date strings
    if (q.search?.trim()) {
      const term = `%${q.search.trim()}%`;
      where.push(
        `(w.withdrawal_code ILIKE $${i}
          OR w.receive_number ILIKE $${i}
          OR u.username ILIKE $${i}
          OR u.full_name ILIKE $${i}
          OR TO_CHAR(w.requested_at, 'YYYY-MM-DD') ILIKE $${i}
          OR TO_CHAR(w.requested_at, 'DD-MM-YYYY') ILIKE $${i})`,
      );
      params.push(term);
      i++;
    }

    if (q.gatewayId) {
      where.push(`w.gateway_id = $${i++}`);
      params.push(q.gatewayId);
    }

    if (q.userId) {
      where.push(`w.user_id = $${i++}`);
      params.push(q.userId);
    }

    // Date range on requested_at (Created Time)
    if (q.dateFrom) {
      where.push(`w.requested_at >= $${i++}::date`);
      params.push(q.dateFrom);
    }
    if (q.dateTo) {
      where.push(`w.requested_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.dateTo);
    }

    // Member Group = VIP tier name (same convention as deposit search)
    if (q.memberGroup?.trim()) {
      where.push(`(vlc.group_name ILIKE $${i} OR vlc.level_name ILIKE $${i})`);
      params.push(q.memberGroup.trim());
      i++;
    }

    // Member ID = users.user_code
    if (q.memberId?.trim()) {
      where.push(`u.user_code ILIKE $${i++}`);
      params.push(`%${q.memberId.trim()}%`);
    }

    // Phone — digits-only compare against the payout receive_number AND every
    // saved player number, so +880/880/0-prefixed input all match either.
    if (q.phone?.trim()) {
      const digits = q.phone.replace(/\D/g, '').replace(/^880/, '').replace(/^0/, '');
      where.push(`(
        regexp_replace(w.receive_number, '\\D', '', 'g') LIKE $${i}
        OR EXISTS (
          SELECT 1 FROM user_phone_numbers up
           WHERE up.user_id = u.id
             AND regexp_replace(up.phone_number, '\\D', '', 'g') LIKE $${i}))`);
      params.push(`%${digits}%`);
      i++;
    }

    // TRX ID = withdrawal_code (players don't enter a trx number on payout)
    if (q.trxId?.trim()) {
      where.push(`w.withdrawal_code ILIKE $${i++}`);
      params.push(`%${q.trxId.trim()}%`);
    }

    // WD ID — "WD00212" (or bare digits) → withdrawals.id
    if (q.wdId?.trim()) {
      const idDigits = q.wdId.replace(/\D/g, '');
      where.push(`w.id = $${i++}`);
      params.push(idDigits ? parseInt(idDigits, 10) : -1);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Pending queue reads oldest-first (approval order); decided/mixed
    // listings read newest-first.
    const order = status === 'PENDING' ? 'ASC' : 'DESC';

    const rows = await this.dataSource.query(
      `SELECT
         w.id,
         'WD' || LPAD(w.id::text, 5, '0') AS wd_id,
         w.withdrawal_code,
         w.user_id,
         w.amount,
         w.amount::numeric(18,2)                        AS total_amount,
         w.receive_number,
         w.status,
         w.requested_at,
         w.decided_at,
         w.rejection_reason,
         -- User info
         u.full_name,
         u.username,
         u.email,
         u.user_code                                    AS member_id,
         u.vip_level,
         COALESCE(vlc.group_name, vlc.level_name)       AS vip_level_name,
         ph.phone_number                                AS player_number,
         -- Withdrawals are always player-initiated (no admin-created flow)
         u.username                                     AS created_by,
         -- Gateway
         g.id   AS gateway_id,
         g.name AS gateway_name,
         -- Deciding admin (Approve/Reject By)
         adm.name  AS decided_by_name,
         adm.email AS decided_by_email
       FROM withdrawals w
       JOIN users u            ON u.id = w.user_id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       JOIN payment_gateways g ON g.id = w.gateway_id
       LEFT JOIN admin_users adm ON adm.id = w.approved_by_admin_id
       LEFT JOIN LATERAL (
         SELECT up.phone_number
           FROM user_phone_numbers up
          WHERE up.user_id = u.id
          ORDER BY up.is_primary DESC, up.id ASC
          LIMIT 1
       ) ph ON TRUE
       ${whereSql}
       ORDER BY w.requested_at ${order}
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
       FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN vip_level_config vlc ON vlc.level = u.vip_level
       ${whereSql}`,
      params,
    );

    return {
      data:  rows,
      total: countRows[0].total,
      page,
      limit,
      status, // kept for backward compat with the old response shape
      filters: {
        status,
        search:      q.search      ?? null,
        gatewayId:   q.gatewayId   ?? null,
        userId:      q.userId      ?? null,
        dateFrom:    q.dateFrom    ?? null,
        dateTo:      q.dateTo      ?? null,
        memberGroup: q.memberGroup ?? null,
        memberId:    q.memberId    ?? null,
        phone:       q.phone       ?? null,
        trxId:       q.trxId       ?? null,
        wdId:        q.wdId        ?? null,
      },
    };
  }

  // ═════════════════════════════════════════════════════════════
  // USER: GET WALLET (single snapshot incl. coins + VIP)
  // ═════════════════════════════════════════════════════════════
  async getWallet(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT
          w.id,
          w.balance,
          w.bonus_balance,
          w.locked_balance,
          w.total_deposited,
          w.total_withdrawn,
          w.total_bet,
          w.total_win,
          w.updated_at,
          u.vip_level,
          uc.total_coins,
          uc.lifetime_coins
       FROM wallets w
       JOIN users u ON u.id = w.user_id
       LEFT JOIN user_coins uc ON uc.user_id = w.user_id
       WHERE w.user_id = $1
       LIMIT 1`,
      [userId],
    );

    if (!rows.length) {
      throw new NotFoundException('Wallet not found');
    }

    const w = rows[0];
    return {
      balance:        parseFloat(w.balance),
      bonusBalance:   parseFloat(w.bonus_balance),
      lockedBalance:  parseFloat(w.locked_balance),
      totalDeposited: parseFloat(w.total_deposited),
      totalWithdrawn: parseFloat(w.total_withdrawn),
      totalBet:       parseFloat(w.total_bet ?? 0),
      totalWin:       parseFloat(w.total_win ?? 0),
      vipLevel:       w.vip_level,
      coins:          parseFloat(w.total_coins ?? 0),
      lifetimeCoins:  parseFloat(w.lifetime_coins ?? 0),
      updatedAt:      w.updated_at,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // USER: LEDGER HISTORY (paginated)
  // ═════════════════════════════════════════════════════════════
async getLedgerHistory(
  userId: number,
  page = 1,
  limit = 20,
  typeFilter?: string,
  role: 'USER' | 'ADMIN' = 'USER',   // ← NEW param
) {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const safePage  = Math.max(page, 1);
  const offset    = (safePage - 1) * safeLimit;

  // ─── Role-based label maps ────────────────────────────────
  const USER_LABELS: Record<string, string> = {
    DEPOSIT_PENDING:        'DEPOSIT',
    DEPOSIT_APPROVED:       'DEPOSIT',
    DEPOSIT_REJECTED:       'DEPOSIT',
    MANUAL_DEPOSIT:         'DEPOSIT',      // ← user sees "DEPOSIT"
    MANUAL_ADJUSTMENT:      'ADJUSTMENT',
    WITHDRAWAL_REQUESTED:   'WITHDRAWAL',
    WITHDRAWAL_APPROVED:    'WITHDRAWAL',
    WITHDRAWAL_REJECTED:    'WITHDRAWAL',
    REFERRAL_BONUS_CREDIT:  'BONUS',
    PROMOTION_BONUS:        'BONUS',
    WIN_CREDIT:             'WIN',
    BET_PLACED:             'BET',
    BET_CANCELLED:          'BET',
    AFFILIATE_COMMISSION_CREDIT: 'AFFILIATE COMMISSION',
  };

  const ADMIN_LABELS: Record<string, string> = {
    DEPOSIT_PENDING:        'DEPOSIT',
    DEPOSIT_APPROVED:       'DEPOSIT',
    DEPOSIT_REJECTED:       'DEPOSIT',
    MANUAL_DEPOSIT:         'MANUAL DEPOSIT',   // ← admin sees "MANUAL DEPOSIT"
    MANUAL_ADJUSTMENT:      'MANUAL ADJUST',    // ← admin sees "MANUAL ADJUST"
    WITHDRAWAL_REQUESTED:   'WITHDRAWAL',
    WITHDRAWAL_APPROVED:    'WITHDRAWAL',
    WITHDRAWAL_REJECTED:    'WITHDRAWAL',
    REFERRAL_BONUS_CREDIT:  'BONUS',
    PROMOTION_BONUS:        'BONUS',
    WIN_CREDIT:             'WIN',
    BET_PLACED:             'BET',
    BET_CANCELLED:          'BET',
    AFFILIATE_COMMISSION_CREDIT: 'AFFILIATE COMMISSION',
  };

  const labelMap = role === 'ADMIN' ? ADMIN_LABELS : USER_LABELS;

  // ─── Transaction-only feed ───────────────────────────────
  // This endpoint is the money-movement statement: DEPOSITS, WITHDRAWALS and
  // manual ADJUSTMENTS (admin credit/debit). Bets/wins/bonuses live in
  // game-history / other views and are excluded here.
  const DEPOSIT_TYPES = [
    'DEPOSIT_PENDING', 'DEPOSIT_APPROVED', 'DEPOSIT_REJECTED', 'MANUAL_DEPOSIT',
  ];
  const WITHDRAWAL_TYPES = [
    'WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED',
  ];
  // Manual admin adjustments (credit "Weekly Loss Bonus", debit claw-back).
  // These must appear in the statement with their description + amount.
  const ADJUSTMENT_TYPES = ['MANUAL_ADJUSTMENT'];
  // Approved affiliate → player commission transfers.
  const AFFILIATE_TYPES = ['AFFILIATE_COMMISSION_CREDIT'];

  // Optional ?type= narrows the feed. Accepts ONE or MANY (comma-separated)
  // of: DEPOSIT | WITHDRAWAL | ADJUSTMENT | AFFILIATE — e.g.
  // ?type=ADJUSTMENT,AFFILIATE returns admin adjustments + affiliate-commission
  // credits together. Unrecognised / empty → all four. Bet/win/bonus excluded.
  const typeMap: Record<string, string[]> = {
    DEPOSIT: DEPOSIT_TYPES,
    WITHDRAWAL: WITHDRAWAL_TYPES,
    ADJUSTMENT: ADJUSTMENT_TYPES,
    AFFILIATE: AFFILIATE_TYPES,
  };
  const requested = (typeFilter ?? '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter((f) => typeMap[f]);
  let effectiveTypes: string[];
  if (requested.length) {
    // Union of the recognised buckets, de-duplicated.
    effectiveTypes = [...new Set(requested.flatMap((f) => typeMap[f]))];
  } else {
    effectiveTypes = [...DEPOSIT_TYPES, ...WITHDRAWAL_TYPES, ...ADJUSTMENT_TYPES, ...AFFILIATE_TYPES];
  }

  const params: any[] = [userId, ...effectiveTypes];
  const typePlaceholders = effectiveTypes
    .map((_, idx) => `$${idx + 2}`)
    .join(', ');
  const whereClause = `WHERE fl.user_id = $1 AND fl.entry_type IN (${typePlaceholders})`;

  const dataParams  = [...params, safeLimit, offset];
  const countParams = [...params];

  // A deposit/withdrawal writes MULTIPLE ledger rows over its lifecycle
  // (e.g. DEPOSIT_PENDING then DEPOSIT_APPROVED). For this money-movement
  // statement we want ONE row per deposit/withdrawal showing its CURRENT
  // state, so we collapse to the latest ledger entry per reference via
  // DISTINCT ON. Rows without a reference (manual adjustments) fall back to
  // their own ledger id, so each stays distinct.
  const groupKey =
    `COALESCE(fl.reference_type, ''), COALESCE(fl.reference_id::text, fl.id::text)`;

  // Join through the deposit → agent chain so deposit rows carry the
  // agent's wallet type (bKash / Nagad / Upay) the user paid into.
  // Withdrawal rows have no agent, so these come back null.
  const rows = await this.dataSource.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (${groupKey})
          fl.id, fl.ledger_code, fl.entry_type, fl.flow, fl.amount,
          fl.balance_before, fl.balance_after,
          fl.reference_type, fl.reference_id,
          fl.status, fl.description, fl.created_by_type, fl.created_at,
          -- Human transaction id — same formats the admin already sees on the
          -- deposit/withdrawal lists (DP00292 / WD00033) and affiliate
          -- transfers (TR-1001). Rows with no external reference (manual
          -- adjustments) keep their FIN ledger code.
          CASE
            WHEN fl.reference_type = 'DEPOSIT'            AND fl.reference_id IS NOT NULL
              THEN 'DP' || LPAD(fl.reference_id::text, 5, '0')
            WHEN fl.reference_type = 'WITHDRAWAL'         AND fl.reference_id IS NOT NULL
              THEN 'WD' || LPAD(fl.reference_id::text, 5, '0')
            WHEN fl.reference_type = 'AFFILIATE_TRANSFER' AND fl.reference_id IS NOT NULL
              THEN 'TR-' || (1000 + fl.reference_id)::text
            ELSE fl.ledger_code
          END             AS transaction_id,
          d.transaction_number,
          d.provider      AS deposit_provider,
          COALESCE(d.transaction_number, d.provider_txn_id) AS deposit_trx_id,
          w.withdrawal_code,
          a.wallet_type   AS agent_wallet_type,
          a.agent_number  AS agent_number,
          COALESCE(g.name, wg.name) AS gateway_name
       FROM financial_ledger fl
       LEFT JOIN deposits d
              ON fl.reference_type = 'DEPOSIT' AND fl.reference_id = d.id
       LEFT JOIN agents a            ON a.id = d.agent_id
       LEFT JOIN payment_gateways g  ON g.id = d.gateway_id
       LEFT JOIN withdrawals w
              ON fl.reference_type = 'WITHDRAWAL' AND fl.reference_id = w.id
       LEFT JOIN payment_gateways wg ON wg.id = w.gateway_id
       ${whereClause}
       ORDER BY ${groupKey}, fl.created_at DESC, fl.id DESC
     ) sub
     ORDER BY sub.created_at DESC, sub.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    dataParams,
  );

  const count = await this.dataSource.query(
    `SELECT COUNT(*)::int AS total FROM (
       SELECT DISTINCT ${groupKey}
       FROM financial_ledger fl
       ${whereClause}
     ) sub`,
    countParams,
  );

  return {
    data: rows.map((row) => {
      const {
        agent_wallet_type, agent_number, gateway_name,
        transaction_id, deposit_trx_id, withdrawal_code, deposit_provider,
        ...rest
      } = row;
      return {
        ...rest,
        // Deposit-table transaction number exactly as the player typed it
        // during deposit (null for withdrawals/adjustments) — same key as
        // the admin deposit list. Kept in `rest` via d.transaction_number.
        transactionId: transaction_id,
        // Gateway-side TRX reference: the trx id the user submitted with the
        // deposit, or the withdrawal's payout code. Null for adjustments.
        trxId: deposit_trx_id ?? withdrawal_code ?? null,
        // 'WINYPAY' = automated PSP (transaction_number is system-generated);
        // null = manual agent deposit (transaction_number is player-typed).
        provider: deposit_provider ?? null,
        typeLabel: labelMap[row.entry_type] ?? row.entry_type,
        // Where the money went/came from — populated for deposits only.
        walletType:  agent_wallet_type ?? null,
        agentNumber: agent_number ?? null,
        gatewayName: gateway_name ?? null,
      };
    }),
    page: safePage,
    limit: safeLimit,
    total: count[0].total,
    totalPages: Math.ceil(count[0].total / safeLimit),
  };
}
}
