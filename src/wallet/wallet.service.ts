// src/wallet/wallet.service.ts
// FULL refactor. Replace your entire wallet.service.ts with this.
// Changes: writeLedger() REMOVED. All ledger writes now go through
// injected FinancialLedgerService. Everything else is identical behavior.

import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { AdminAdjustmentDto, AdminDepositDecideDto, AdminWithdrawalDecideDto, DepositRequestDto, WithdrawalRequestDto } from './dto';
import { generateCode } from 'src/Utils';
import { CoinsService } from 'src/coins/coins.service';




@Injectable()
export class WalletService {
  constructor(
    private dataSource: DataSource,
    private financialLedger: FinancialLedgerService, // ← injected now
     private coinService: CoinsService
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
  // ═════════════════════════════════════════════════════════════
  async requestDeposit(dto: DepositRequestDto) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
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
        walletId:      wallet.id,
        userId:        dto.userId,
        entryType:     'DEPOSIT_PENDING',
        flow:          'CREDIT',
        amount:        dto.amount,
        balanceBefore: bal,
        balanceAfter:  bal,
        bonusBefore:   bon,
        bonusAfter:    bon,
        lockedBefore:  lck,
        lockedAfter:   lck,
        referenceType: 'DEPOSIT',
        referenceId:   depositId,
        status:        'PENDING',
        description:   `Deposit submitted. TxnNo: ${dto.transactionNumber}`,
        createdByType: 'USER',
        createdById:   dto.userId,
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
  //   NOTE: This is where coin award + VIP level-up + turnover req
  //   creation will happen. For now it's still "wallet only" — we'll
  //   extend this in sub-pass 2 (coin/VIP) and sub-pass 3 (turnover).
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
          walletId:      wallet.id,
          userId:        dep.user_id,
          entryType:     'DEPOSIT_APPROVED',
          flow:          'CREDIT',
          amount:        amt,
          balanceBefore: bal,
          balanceAfter:  newBal,
          bonusBefore:   bon,
          bonusAfter:    bon,
          lockedBefore:  lck,
          lockedAfter:   lck,
          referenceType: 'DEPOSIT',
          referenceId:   dto.depositId,
          status:        'SUCCESS',
          description:   'Deposit approved by admin',
          createdByType: 'ADMIN',
          createdById:   dto.adminId,
        });

        // ┌─────────────────────────────────────────────────────┐
        // │ FUTURE HOOKS (added in sub-pass 2 & 3):             │
        // │   await this.coinService.awardForDeposit(qr, ...);  │
        // │   await this.vipService.checkLevelUp(qr, userId);   │
        // │   await this.turnoverService.createFromDeposit(...);│
        // └─────────────────────────────────────────────────────┘
         // ─── COIN AWARD (Sub-pass 2) ─────────────────────────────
      // VIP level-up is auto-triggered inside CoinService after credit.
       const coinResult = await this.coinService.awardForDeposit(
        qr,
        dep.user_id,
        amt,
        dto.depositId,
      );


        await qr.commitTransaction();
        return { 
          message: 'Deposit approved. Wallet credited.', 
          newBalance: newBal ,
          coinsEarned: coinResult?.awarded ?? 0,
         totalCoins: coinResult?.newTotal ?? null,
        };
      } else {
        // REJECT — no balance change
        await qr.query(
          `UPDATE deposits
           SET status = 'REJECTED', decided_at = NOW(),
               approved_by_admin_id = $1, rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [dto.adminId, dto.rejectionReason ?? null, dto.depositId],
        );

        await this.financialLedger.write({
          qr,
          walletId:      wallet.id,
          userId:        dep.user_id,
          entryType:     'DEPOSIT_REJECTED',
          flow:          'DEBIT',
          amount:        amt,
          balanceBefore: bal,
          balanceAfter:  bal,
          bonusBefore:   bon,
          bonusAfter:    bon,
          lockedBefore:  lck,
          lockedAfter:   lck,
          referenceType: 'DEPOSIT',
          referenceId:   dto.depositId,
          status:        'FAILED',
          description:   dto.rejectionReason ?? 'Deposit rejected by admin',
          createdByType: 'ADMIN',
          createdById:   dto.adminId,
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
  //   Turnover check will be plugged in at sub-pass 3.
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

      // ┌─────────────────────────────────────────────────────┐
      // │ FUTURE HOOK (sub-pass 3):                           │
      // │   await this.turnoverService.ensureNoActiveReqs(    │
      // │     qr, dto.userId                                  │
      // │   );  // throws if any requirement incomplete       │
      // └─────────────────────────────────────────────────────┘

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
        walletId:      wallet.id,
        userId:        dto.userId,
        entryType:     'WITHDRAWAL_REQUESTED',
        flow:          'LOCK',
        amount:        dto.amount,
        balanceBefore: bal,
        balanceAfter:  newBal,
        bonusBefore:   bon,
        bonusAfter:    bon,
        lockedBefore:  lck,
        lockedAfter:   newLck,
        referenceType: 'WITHDRAWAL',
        referenceId:   withdrawalId,
        status:        'PENDING',
        description:   `Withdrawal requested to ${dto.receiveNumber}`,
        createdByType: 'USER',
        createdById:   dto.userId,
      });

      await qr.commitTransaction();
      return {
        message: 'Withdrawal requested. Awaiting admin approval.',
        withdrawalId,
        availableBalance: newBal,
        lockedBalance:    newLck,
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
  //   On APPROVE: turnover reset hook will be added in sub-pass 3.
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
          walletId:      wallet.id,
          userId:        wdr.user_id,
          entryType:     'WITHDRAWAL_APPROVED',
          flow:          'RELEASE',
          amount:        amt,
          balanceBefore: bal,
          balanceAfter:  bal,
          bonusBefore:   bon,
          bonusAfter:    bon,
          lockedBefore:  lck,
          lockedAfter:   newLck,
          referenceType: 'WITHDRAWAL',
          referenceId:   dto.withdrawalId,
          status:        'SUCCESS',
          description:   'Withdrawal approved by admin',
          createdByType: 'ADMIN',
          createdById:   dto.adminId,
        });

        // ┌─────────────────────────────────────────────────────┐
        // │ FUTURE HOOK (sub-pass 3):                           │
        // │   await this.turnoverService.resetAllActive(        │
        // │     qr, wdr.user_id, dto.withdrawalId               │
        // │   );                                                │
        // └─────────────────────────────────────────────────────┘

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
          walletId:      wallet.id,
          userId:        wdr.user_id,
          entryType:     'WITHDRAWAL_REJECTED',
          flow:          'RELEASE',
          amount:        amt,
          balanceBefore: bal,
          balanceAfter:  newBal,
          bonusBefore:   bon,
          bonusAfter:    bon,
          lockedBefore:  lck,
          lockedAfter:   newLck,
          referenceType: 'WITHDRAWAL',
          referenceId:   dto.withdrawalId,
          status:        'FAILED',
          description:   dto.rejectionReason ?? 'Withdrawal rejected. Amount refunded.',
          createdByType: 'ADMIN',
          createdById:   dto.adminId,
        });

        await qr.commitTransaction();
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
  // ADMIN: MANUAL ADJUSTMENT
  // ═════════════════════════════════════════════════════════════
  async adminAdjustWallet(dto: AdminAdjustmentDto) {
    if (dto.amount === 0)
      throw new BadRequestException('Adjustment amount cannot be zero');

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
        entryType:     'MANUAL_ADJUSTMENT',
        flow:          dto.amount > 0 ? 'CREDIT' : 'DEBIT',
        amount:        Math.abs(dto.amount),
        balanceBefore: bal,
        balanceAfter:  newBal,
        bonusBefore:   bon,
        bonusAfter:    bon,
        lockedBefore:  lck,
        lockedAfter:   lck,
        referenceType: 'MANUAL_ADJUSTMENT',
        referenceId:   Number(adj[0].id),
        status:        'SUCCESS',
        description:   dto.description,
        meta:          dto.meta,
        createdByType: 'ADMIN',
        createdById:   dto.adminId,
      });

      await qr.commitTransaction();
      return { message: 'Wallet adjusted.', balanceBefore: bal, balanceAfter: newBal };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST PENDING DEPOSITS — now includes AGENT DETAILS
  //   This is what you asked for: admin sees agent code/number used.
  // ═════════════════════════════════════════════════════════════
  async getPendingDeposits(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const rows = await this.dataSource.query(
      `SELECT
          d.id, d.deposit_code, d.user_id, d.amount,
          d.transaction_number, d.screenshot_url, d.requested_at,
          d.promotion_id,
          u.full_name, u.username, u.email,
          g.id AS gateway_id, g.name AS gateway_name,
          a.id AS agent_id, a.agent_number, a.agent_code, a.wallet_type
       FROM deposits d
       JOIN users u ON u.id = d.user_id
       JOIN payment_gateways g ON g.id = d.gateway_id
       LEFT JOIN agents a ON a.id = d.agent_id
       WHERE d.status = 'PENDING'
       ORDER BY d.requested_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM deposits WHERE status = 'PENDING'`,
    );

    return { data: rows, total: count[0].total, page, limit };
  }

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
      balance:         parseFloat(w.balance),
      bonusBalance:    parseFloat(w.bonus_balance),
      lockedBalance:   parseFloat(w.locked_balance),
      totalDeposited:  parseFloat(w.total_deposited),
      totalWithdrawn:  parseFloat(w.total_withdrawn),
      totalBet:        parseFloat(w.total_bet ?? 0),
      totalWin:        parseFloat(w.total_win ?? 0),
      vipLevel:        w.vip_level,
      coins:           parseFloat(w.total_coins ?? 0),
      lifetimeCoins:   parseFloat(w.lifetime_coins ?? 0),
      updatedAt:       w.updated_at,
    };
  }
 
  // ═════════════════════════════════════════════════════════════
  // USER: GET LEDGER HISTORY (paginated, filterable by entry type)
  // ═════════════════════════════════════════════════════════════
  async getLedgerHistory(userId: number, page = 1, limit = 20) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);  // cap at 100
    const safePage  = Math.max(page, 1);
    const offset    = (safePage - 1) * safeLimit;
 
    const rows = await this.dataSource.query(
      `SELECT
          id, ledger_code, entry_type, flow, amount,
          balance_before, balance_after,
          reference_type, reference_id,
          status, description, created_at
       FROM financial_ledger
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [userId, safeLimit, offset],
    );
 
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM financial_ledger WHERE user_id = $1`,
      [userId],
    );
 
    return {
      data: rows,
      page: safePage,
      limit: safeLimit,
      total: count[0].total,
      totalPages: Math.ceil(count[0].total / safeLimit),
    };
  }
}