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

  // ─── Shared deposit gate ──────────────────────────────────────
  //   The single source of truth for "is this deposit allowed?".
  //   Runs against the supplied query runner (read-only — no writes)
  //   so it can be used both by the pre-flight validateDeposit() and
  //   inside the requestDeposit() transaction. Throws a descriptive
  //   exception on the first failed rule; returns nothing on success.
  //   Rules: phone verified → gateway active → tier min/max → promo
  //   eligibility (full gate: verification, frequency, amount bounds).
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

      const deposit = await qr.query(
        `INSERT INTO deposits
           (deposit_code, user_id, gateway_id, agent_id, promotion_id,
            amount, transaction_number, screenshot_url, status,
            requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',NOW(),NOW(),NOW())
         RETURNING id`,
        [
          generateCode('DP'),
          dto.userId,
          dto.gatewayId,
          dto.agentId ?? null,
          dto.promotionId ?? null,
          dto.amount,
          dto.transactionNumber,
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
      return { message: 'Deposit submitted. Awaiting admin approval.', depositId };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
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
      const deps = await qr.query(
        `SELECT * FROM deposits WHERE id = $1 LIMIT 1`,
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
          createdById: dto.adminId,
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
                adminId: dto.adminId,
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
               approved_by_admin_id = $1, rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [dto.adminId, dto.rejectionReason ?? null, dto.depositId],
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
          createdByType: 'ADMIN',
          createdById: dto.adminId,
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
          createdById: dto.adminId,
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
          createdById: dto.adminId,
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
    // requirement: amount × multiplier. multiplier 0 → no requirement (the
    // user is free to withdraw). Debits never create turnover — they just
    // appear in the transaction history. The description becomes the
    // requirement's header on the user's wagering page.
    let turnover: { requirementId: number; targetAmount: number } | null = null;
    if (dto.amount > 0 && turnoverMultiplier > 0) {
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
         ph.phone_number                                AS player_number,
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
         ph.phone_number                          AS player_number,
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

  // Optional ?type=DEPOSIT | WITHDRAWAL | ADJUSTMENT narrows the feed; anything
  // else (or no filter) returns all three. Bet/win/bonus filters return nothing.
  const filter = typeFilter?.trim().toUpperCase();
  let effectiveTypes: string[];
  if (filter === 'DEPOSIT') {
    effectiveTypes = DEPOSIT_TYPES;
  } else if (filter === 'WITHDRAWAL') {
    effectiveTypes = WITHDRAWAL_TYPES;
  } else if (filter === 'ADJUSTMENT') {
    effectiveTypes = ADJUSTMENT_TYPES;
  } else {
    effectiveTypes = [...DEPOSIT_TYPES, ...WITHDRAWAL_TYPES, ...ADJUSTMENT_TYPES];
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
          a.wallet_type   AS agent_wallet_type,
          a.agent_number  AS agent_number,
          g.name          AS gateway_name
       FROM financial_ledger fl
       LEFT JOIN deposits d
              ON fl.reference_type = 'DEPOSIT' AND fl.reference_id = d.id
       LEFT JOIN agents a            ON a.id = d.agent_id
       LEFT JOIN payment_gateways g  ON g.id = d.gateway_id
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
      const { agent_wallet_type, agent_number, gateway_name, ...rest } = row;
      return {
        ...rest,
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