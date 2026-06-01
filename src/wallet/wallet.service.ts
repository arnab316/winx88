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
  DepositRequestDto,
  WithdrawalRequestDto,
} from './dto';
import { generateCode } from 'src/Utils';
import { CoinsService } from 'src/coins/coins.service';
import { TurnoverService } from '../turnover/turnover.service';
import { GameValidationService } from '../game/game-validation.service';
import { PromotionEngineService } from '../promotion/promotion-engine.service';

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

  // ═════════════════════════════════════════════════════════════
  // DEPOSIT: USER REQUESTS
  //   Pre-flight validates promotion (if attached) before creating
  //   the deposit row. Fails fast on invalid promos.
  // ═════════════════════════════════════════════════════════════
  async requestDeposit(dto: DepositRequestDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // Pre-flight promo validation (cheap; throws on bad promo)
      if (dto.promotionId) {
        await this.promotionEngine.validateForUser(qr, dto.userId, dto.promotionId, {
          kind: 'DEPOSIT',
          depositAmount: dto.amount,
        });
      }

      const deposit = await qr.query(
        `INSERT INTO deposits
           (deposit_code, user_id, gateway_id, agent_id, promotion_id,
            amount, transaction_number, screenshot_url, status,
            requested_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',NOW(),NOW(),NOW())
         RETURNING id`,
        [
          generateCode('DEP'),
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
        }

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
          generateCode('WDR'),
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
  if (dto.amount === 0)
    throw new BadRequestException('Adjustment amount cannot be zero');

  // Validate adjustmentType
  if (!['MANUAL_ADJUSTMENT', 'MANUAL_DEPOSIT'].includes(dto.adjustmentType))
    throw new BadRequestException('Invalid adjustment type');

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
      referenceType: dto.adjustmentType,
      referenceId:   Number(adj[0].id),
      status:        'SUCCESS',
      description:   dto.description,
      meta:          dto.meta,
      createdByType: 'ADMIN',
      createdById:   dto.adminId,
    });

    await qr.commitTransaction();
    await this.walletGateway.pushBalanceUpdate(dto.userId);
    return { message: 'Wallet adjusted.', balanceBefore: bal, balanceAfter: newBal };
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
 
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
 
    const rows = await this.dataSource.query(
      `SELECT
         d.id,
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
         -- User info
         u.full_name,
         u.username,
         u.email,
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
       JOIN payment_gateways g ON g.id  = d.gateway_id
       LEFT JOIN agents a      ON a.id  = d.agent_id
       LEFT JOIN promotions p  ON p.id  = d.promotion_id
       LEFT JOIN admin_users adm ON adm.id = d.approved_by_admin_id
       ${whereSql}
       ORDER BY d.requested_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );
 
    const countRows = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
       FROM deposits d
       JOIN users u ON u.id = d.user_id
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
        search:    q.search    ?? null,
        gatewayId: q.gatewayId ?? null,
        userId:    q.userId    ?? null,
        dateFrom:  q.dateFrom  ?? null,
        dateTo:    q.dateTo    ?? null,
      },
    };
  }
 
  // ─── ADD getDepositById() ────────────────────────────────────
  async getDepositById(depositId: number) {
    const rows = await this.dataSource.query(
      `SELECT
         d.*,
         u.full_name, u.username, u.email,
         g.name AS gateway_name,
         a.agent_number, a.agent_code, a.wallet_type,
         p.title AS promotion_title, p.code AS promotion_code,
         adm.name AS decided_by_name
       FROM deposits d
       JOIN users u            ON u.id  = d.user_id
       JOIN payment_gateways g ON g.id  = d.gateway_id
       LEFT JOIN agents a      ON a.id  = d.agent_id
       LEFT JOIN promotions p  ON p.id  = d.promotion_id
       LEFT JOIN admin_users adm ON adm.id = d.approved_by_admin_id
       WHERE d.id = $1`,
      [depositId],
    );
    if (!rows.length) throw new NotFoundException('Deposit not found');
    return rows[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST PENDING WITHDRAWALS
  // ═════════════════════════════════════════════════════════════
  async getPendingWithdrawals(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const rows = await this.dataSource.query(
      `SELECT w.id, w.withdrawal_code, w.user_id, u.full_name,
              w.amount, w.receive_number,
              g.name AS gateway_name, w.requested_at
       FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       JOIN payment_gateways g ON g.id = w.gateway_id
       WHERE w.status = 'PENDING'
       ORDER BY w.requested_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM withdrawals WHERE status = 'PENDING'`,
    );
    return { data: rows, total: count[0].total, page, limit };
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

  // ─── Type filter → entry_type array ──────────────────────
  const TYPE_REVERSE: Record<string, string[]> = {
    // USER filter tabs
    'DEPOSIT':    ['DEPOSIT_PENDING', 'DEPOSIT_APPROVED', 'DEPOSIT_REJECTED', 'MANUAL_DEPOSIT'],
    'WITHDRAWAL': ['WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED'],
    'BONUS':      ['REFERRAL_BONUS_CREDIT', 'PROMOTION_BONUS'],
    'WIN':        ['WIN_CREDIT'],
    'BET':        ['BET_PLACED', 'BET_CANCELLED'],
    // ADMIN-only filter tabs
    'MANUAL DEPOSIT': ['MANUAL_DEPOSIT'],
    'MANUAL ADJUST':  ['MANUAL_ADJUSTMENT'],
  };

  let whereClause = `WHERE user_id = $1`;
  const params: any[] = [userId];

  if (typeFilter && TYPE_REVERSE[typeFilter]) {
    const placeholders = TYPE_REVERSE[typeFilter]
      .map((_, idx) => `$${idx + 2}`)
      .join(', ');
    whereClause += ` AND entry_type IN (${placeholders})`;
    params.push(...TYPE_REVERSE[typeFilter]);
  }

  const dataParams  = [...params, safeLimit, offset];
  const countParams = [...params];

  const rows = await this.dataSource.query(
    `SELECT
        id, ledger_code, entry_type, flow, amount,
        balance_before, balance_after,
        reference_type, reference_id,
        status, description, created_by_type, created_at
     FROM financial_ledger
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    dataParams,
  );

  const count = await this.dataSource.query(
    `SELECT COUNT(*)::int AS total FROM financial_ledger ${whereClause}`,
    countParams,
  );

  return {
    data: rows.map((row) => ({
      ...row,
      typeLabel: labelMap[row.entry_type] ?? row.entry_type,
    })),
    page: safePage,
    limit: safeLimit,
    total: count[0].total,
    totalPages: Math.ceil(count[0].total / safeLimit),
  };
}
}