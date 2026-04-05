import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AdminAdjustmentDto, AdminDepositDecideDto, AdminWithdrawalDecideDto, DepositRequestDto, LedgerParams, WithdrawalRequestDto } from './dto';
import { generateCode } from 'src/Utils';



// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class WalletService {
  constructor(private dataSource: DataSource) {}

  // ─── PRIVATE: lock wallet row ────────────────────────────────────────────

  private async getWalletForUpdate(queryRunner: any, userId: number) {
    const rows = await queryRunner.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('Wallet not found');
    return rows[0];
  }

  // ─── PRIVATE: append ledger entry ────────────────────────────────────────

  private async writeLedger(queryRunner: any, p: LedgerParams) {
    await queryRunner.query(
      `INSERT INTO financial_ledger (
          ledger_code, user_id, wallet_id,
          entry_type, flow, amount,
          balance_before, balance_after,
          bonus_before, bonus_after,
          locked_before, locked_after,
          reference_type, reference_id,
          status, description, meta,
          created_by_type, created_by_id,
          created_at
        ) VALUES (
          $1,  $2,  $3,
          $4,  $5,  $6,
          $7,  $8,
          $9,  $10,
          $11, $12,
          $13, $14,
          $15, $16, $17,
          $18, $19,
          NOW()
        )`,
      [
        generateCode('LDG'),
        p.userId,
        p.walletId,
        p.entryType,
        p.flow,
        p.amount,
        p.balanceBefore,
        p.balanceAfter,
        p.bonusBefore  ?? 0,
        p.bonusAfter   ?? 0,
        p.lockedBefore ?? 0,
        p.lockedAfter  ?? 0,
        p.referenceType,
        p.referenceId,
        p.status        ?? 'SUCCESS',
        p.description   ?? null,
        p.meta ? JSON.stringify(p.meta) : null,
        p.createdByType ?? 'SYSTEM',
        p.createdById   ?? null,
      ],
    );
  }

  // ─── GET WALLET ──────────────────────────────────────────────────────────

  async getWallet(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT id, balance, bonus_balance, locked_balance,
              total_deposited, total_withdrawn, updated_at
       FROM wallets WHERE user_id = $1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('Wallet not found');
    return rows[0];
  }

  // ─── LEDGER HISTORY ──────────────────────────────────────────────────────

  async getLedgerHistory(userId: number, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT id, ledger_code, entry_type, flow, amount,
                balance_before, balance_after,
                bonus_before, bonus_after,
                reference_type, reference_id,
                status, description, created_at
         FROM financial_ledger
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM financial_ledger WHERE user_id = $1`,
        [userId],
      ),
    ]);
    return { data: rows, total: parseInt(count[0].total), page, limit };
  }

  // ─── DEPOSIT: USER SUBMITS ────────────────────────────────────────────────

  async requestDeposit(dto: DepositRequestDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const user = await queryRunner.query(
        `SELECT id, account_status FROM users WHERE id = $1 LIMIT 1`,
        [dto.userId],
      );
      if (!user.length) throw new NotFoundException('User not found');
      if (user[0].account_status !== 'ACTIVE')
        throw new ForbiddenException(`Account is ${user[0].account_status}`);

      const gateway = await queryRunner.query(
        `SELECT id FROM payment_gateways WHERE id = $1 AND is_active = true LIMIT 1`,
        [dto.gatewayId],
      );
      if (!gateway.length)
        throw new BadRequestException('Payment gateway not found or inactive');

      const deposit = await queryRunner.query(
        `INSERT INTO deposits
           (deposit_code, user_id, gateway_id, amount, transaction_number, screenshot_url,
            status, requested_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW(), NOW(), NOW())
         RETURNING id`,
        [
          generateCode('DEP'),
          dto.userId,
          dto.gatewayId,
          dto.amount,
          dto.transactionNumber,
          dto.screenshotUrl,
        ],
      );
      const depositId = deposit[0].id;

      // Informational ledger entry — no balance change yet
      const wallet = await this.getWalletForUpdate(queryRunner, dto.userId);

      await this.writeLedger(queryRunner, {
        walletId:      wallet.id,
        userId:        dto.userId,
        entryType:     'DEPOSIT_PENDING',
        flow:          'CREDIT',
        amount:        dto.amount,
        balanceBefore: parseFloat(wallet.balance),
        balanceAfter:  parseFloat(wallet.balance),   // unchanged until approved
        bonusBefore:   parseFloat(wallet.bonus_balance),
        bonusAfter:    parseFloat(wallet.bonus_balance),
        lockedBefore:  parseFloat(wallet.locked_balance),
        lockedAfter:   parseFloat(wallet.locked_balance),
        referenceType: 'DEPOSIT',
        referenceId:   depositId,
        status:        'PENDING',
        description:   `Deposit submitted. TxnNo: ${dto.transactionNumber}`,
        createdByType: 'USER',
        createdById:   dto.userId,
      });

      await queryRunner.commitTransaction();
      return { message: 'Deposit submitted. Awaiting admin approval.', depositId };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── DEPOSIT: ADMIN DECIDES ───────────────────────────────────────────────

  async decideDeposit(dto: AdminDepositDecideDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const deps = await queryRunner.query(
        `SELECT * FROM deposits WHERE id = $1 LIMIT 1`,
        [dto.depositId],
      );
      if (!deps.length) throw new NotFoundException('Deposit not found');

      const dep = deps[0];
      if (dep.status !== 'PENDING')
        throw new BadRequestException(`Deposit already ${dep.status}`);

      const wallet = await this.getWalletForUpdate(queryRunner, dep.user_id);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);
      const amt = parseFloat(dep.amount);

      if (dto.action === 'APPROVE') {
        const newBal = bal + amt;

        await queryRunner.query(
          `UPDATE wallets
           SET balance = $1, total_deposited = total_deposited + $2, updated_at = NOW()
           WHERE id = $3`,
          [newBal, amt, wallet.id],
        );

        await queryRunner.query(
          `UPDATE deposits
           SET status = 'APPROVED', decided_at = NOW(),
               approved_by_admin_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [dto.adminId, dto.depositId],
        );

        await this.writeLedger(queryRunner, {
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

        await queryRunner.commitTransaction();
        return { message: 'Deposit approved. Wallet credited.', newBalance: newBal };

      } else {
        // REJECT — no balance change
        await queryRunner.query(
          `UPDATE deposits
           SET status = 'REJECTED', decided_at = NOW(),
               approved_by_admin_id = $1, rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [dto.adminId, dto.rejectionReason ?? null, dto.depositId],
        );

        await this.writeLedger(queryRunner, {
          walletId:      wallet.id,
          userId:        dep.user_id,
          entryType:     'DEPOSIT_REJECTED',
          flow:          'DEBIT',
          amount:        amt,
          balanceBefore: bal,
          balanceAfter:  bal,   // no change
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

        await queryRunner.commitTransaction();
        return { message: 'Deposit rejected.' };
      }
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── WITHDRAWAL: USER REQUESTS ────────────────────────────────────────────

  async requestWithdrawal(dto: WithdrawalRequestDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const user = await queryRunner.query(
        `SELECT id, account_status FROM users WHERE id = $1 LIMIT 1`,
        [dto.userId],
      );
      if (!user.length) throw new NotFoundException('User not found');
      if (user[0].account_status !== 'ACTIVE')
        throw new ForbiddenException(`Account is ${user[0].account_status}`);

      const gateway = await queryRunner.query(
        `SELECT id FROM payment_gateways WHERE id = $1 AND is_active = true LIMIT 1`,
        [dto.gatewayId],
      );
      if (!gateway.length)
        throw new BadRequestException('Payment gateway not found or inactive');

      const wallet = await this.getWalletForUpdate(queryRunner, dto.userId);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);

      if (bal < dto.amount)
        throw new BadRequestException(`Insufficient balance. Available: ${bal}`);

      const newBal = bal - dto.amount;
      const newLck = lck + dto.amount;

      // Deduct from balance, move to locked_balance
      await queryRunner.query(
        `UPDATE wallets
         SET balance = $1, locked_balance = $2, updated_at = NOW()
         WHERE id = $3`,
        [newBal, newLck, wallet.id],
      );

      const withdrawal = await queryRunner.query(
        `INSERT INTO withdrawals
           (withdrawal_code, user_id, gateway_id, amount, receive_number,
            status, requested_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW(), NOW(), NOW())
         RETURNING id`,
        [
          generateCode('WDR'),
          dto.userId,
          dto.gatewayId,
          dto.amount,
          dto.receiveNumber,
        ],
      );
      const withdrawalId = withdrawal[0].id;

      await this.writeLedger(queryRunner, {
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

      await queryRunner.commitTransaction();
      return {
        message: 'Withdrawal requested. Awaiting admin approval.',
        withdrawalId,
        availableBalance: newBal,
        lockedBalance:    newLck,
      };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── WITHDRAWAL: ADMIN DECIDES ────────────────────────────────────────────

  async decideWithdrawal(dto: AdminWithdrawalDecideDto) {
    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const wdrs = await queryRunner.query(
        `SELECT * FROM withdrawals WHERE id = $1 LIMIT 1`,
        [dto.withdrawalId],
      );
      if (!wdrs.length) throw new NotFoundException('Withdrawal not found');

      const wdr = wdrs[0];
      if (wdr.status !== 'PENDING')
        throw new BadRequestException(`Withdrawal already ${wdr.status}`);

      const wallet = await this.getWalletForUpdate(queryRunner, wdr.user_id);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);
      const amt = parseFloat(wdr.amount);

      if (dto.action === 'APPROVE') {
        const newLck = lck - amt;

        // Release from locked, add to total_withdrawn
        await queryRunner.query(
          `UPDATE wallets
           SET locked_balance = $1, total_withdrawn = total_withdrawn + $2, updated_at = NOW()
           WHERE id = $3`,
          [newLck, amt, wallet.id],
        );

        await queryRunner.query(
          `UPDATE withdrawals
           SET status = 'APPROVED', decided_at = NOW(),
               approved_by_admin_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [dto.adminId, dto.withdrawalId],
        );

        await this.writeLedger(queryRunner, {
          walletId:      wallet.id,
          userId:        wdr.user_id,
          entryType:     'WITHDRAWAL_APPROVED',
          flow:          'RELEASE',
          amount:        amt,
          balanceBefore: bal,
          balanceAfter:  bal,    // balance was already deducted at request time
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

        await queryRunner.commitTransaction();
        return { message: 'Withdrawal approved.' };

      } else {
        // REJECT — refund locked back to balance
        const newBal = bal + amt;
        const newLck = lck - amt;

        await queryRunner.query(
          `UPDATE wallets
           SET balance = $1, locked_balance = $2, updated_at = NOW()
           WHERE id = $3`,
          [newBal, newLck, wallet.id],
        );

        await queryRunner.query(
          `UPDATE withdrawals
           SET status = 'REJECTED', decided_at = NOW(),
               approved_by_admin_id = $1, rejection_reason = $2, updated_at = NOW()
           WHERE id = $3`,
          [dto.adminId, dto.rejectionReason ?? null, dto.withdrawalId],
        );

        await this.writeLedger(queryRunner, {
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

        await queryRunner.commitTransaction();
        return { message: 'Withdrawal rejected. Balance refunded.', newBalance: newBal };
      }
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── ADMIN: MANUAL ADJUSTMENT ─────────────────────────────────────────────

  async adminAdjustWallet(dto: AdminAdjustmentDto) {
    if (dto.amount === 0)
      throw new BadRequestException('Adjustment amount cannot be zero');

    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const wallet = await this.getWalletForUpdate(queryRunner, dto.userId);
      const bal = parseFloat(wallet.balance);
      const bon = parseFloat(wallet.bonus_balance);
      const lck = parseFloat(wallet.locked_balance);
      const newBal = bal + dto.amount;

      if (newBal < 0)
        throw new BadRequestException(
          `Adjustment results in negative balance (${newBal})`,
        );

      await queryRunner.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
        [newBal, wallet.id],
      );

      const adj = await queryRunner.query(
        `INSERT INTO manual_adjustments (admin_id, user_id, amount, description, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         RETURNING id`,
        [dto.adminId, dto.userId, dto.amount, dto.description],
      );

      await this.writeLedger(queryRunner, {
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
        referenceId:   adj[0].id,
        status:        'SUCCESS',
        description:   dto.description,
        meta:          dto.meta,
        createdByType: 'ADMIN',
        createdById:   dto.adminId,
      });

      await queryRunner.commitTransaction();
      return {
        message: 'Wallet adjusted.',
        balanceBefore: bal,
        balanceAfter:  newBal,
      };
    } catch (e) {
      await queryRunner.rollbackTransaction();
      throw e;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── INTERNAL: debit for bet ──────────────────────────────────────────────
  // Called from BettingService — pass the SAME queryRunner for atomicity.

  async debitForBet(
    queryRunner: any,
    userId: number,
    amount: number,
    betId: number,
  ) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);
    const bal = parseFloat(wallet.balance);
    const bon = parseFloat(wallet.bonus_balance);
    const lck = parseFloat(wallet.locked_balance);

    if (bal < amount)
      throw new BadRequestException(`Insufficient balance. Available: ${bal}`);

    const newBal = bal - amount;

    await queryRunner.query(
      `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBal, wallet.id],
    );

    await this.writeLedger(queryRunner, {
      walletId:      wallet.id,
      userId,
      entryType:     'BET_PLACED',
      flow:          'DEBIT',
      amount,
      balanceBefore: bal,
      balanceAfter:  newBal,
      bonusBefore:   bon,
      bonusAfter:    bon,
      lockedBefore:  lck,
      lockedAfter:   lck,
      referenceType: 'BET',
      referenceId:   betId,
      description:   `Bet placed. BetID: ${betId}`,
      createdByType: 'USER',
      createdById:   userId,
    });

    return { balanceBefore: bal, balanceAfter: newBal };
  }

  // ─── INTERNAL: credit for win ─────────────────────────────────────────────
  // Called from ResultService — pass the SAME queryRunner for atomicity.

  async creditForWin(
    queryRunner: any,
    userId: number,
    amount: number,
    settlementId: number,
    description?: string,
  ) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);
    const bal = parseFloat(wallet.balance);
    const bon = parseFloat(wallet.bonus_balance);
    const lck = parseFloat(wallet.locked_balance);
    const newBal = bal + amount;

    await queryRunner.query(
      `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBal, wallet.id],
    );

    await this.writeLedger(queryRunner, {
      walletId:      wallet.id,
      userId,
      entryType:     'WIN_CREDIT',
      flow:          'CREDIT',
      amount,
      balanceBefore: bal,
      balanceAfter:  newBal,
      bonusBefore:   bon,
      bonusAfter:    bon,
      lockedBefore:  lck,
      lockedAfter:   lck,
      referenceType: 'BET_SETTLEMENT',
      referenceId:   settlementId,
      description:   description ?? 'Win credited',
      createdByType: 'SYSTEM',
    });

    return { balanceBefore: bal, balanceAfter: newBal };
  }

  // ─── INTERNAL: referral bonus ─────────────────────────────────────────────
  // Bonus goes to bonus_balance, not main balance.

  async creditReferralBonus(
    queryRunner: any,
    userId: number,
    amount: number,
    referralId: number,
    description?: string,
  ) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);
    const bal = parseFloat(wallet.balance);
    const bon = parseFloat(wallet.bonus_balance);
    const lck = parseFloat(wallet.locked_balance);
    const newBon = bon + amount;

    await queryRunner.query(
      `UPDATE wallets SET bonus_balance = $1, updated_at = NOW() WHERE id = $2`,
      [newBon, wallet.id],
    );

    await this.writeLedger(queryRunner, {
      walletId:      wallet.id,
      userId,
      entryType:     'REFERRAL_BONUS_CREDIT',
      flow:          'CREDIT',
      amount,
      balanceBefore: bal,
      balanceAfter:  bal,
      bonusBefore:   bon,
      bonusAfter:    newBon,
      lockedBefore:  lck,
      lockedAfter:   lck,
      referenceType: 'REFERRAL_BONUS',
      referenceId:   referralId,
      description:   description ?? 'Referral bonus credited',
      createdByType: 'SYSTEM',
    });

    return { bonusBefore: bon, bonusAfter: newBon };
  }

  // ─── ADMIN: list pending deposits ─────────────────────────────────────────

 async getPendingDeposits(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT d.id, d.deposit_code, d.user_id, u.full_name, u.username, u.email,
                d.amount, d.transaction_number, d.screenshot_url,
                g.name AS gateway_name, d.requested_at
         FROM deposits d
         JOIN users u ON u.id = d.user_id
         JOIN payment_gateways g ON g.id = d.gateway_id
         WHERE d.status = 'PENDING'
         ORDER BY d.requested_at ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM deposits WHERE status = 'PENDING'`,
      ),
    ]);
    return { data: rows, total: parseInt(count[0].total), page, limit };
  }

  // ─── ADMIN: list pending withdrawals ──────────────────────────────────────

  async getPendingWithdrawals(page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT w.id, w.withdrawal_code, w.user_id, u.name AS full_name,
                w.amount, w.receive_number,
                g.name AS gateway_name, w.requested_at
         FROM withdrawals w
         JOIN users u ON u.id = w.user_id
         JOIN payment_gateways g ON g.id = w.gateway_id
         WHERE w.status = 'PENDING'
         ORDER BY w.requested_at ASC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) AS total FROM withdrawals WHERE status = 'PENDING'`,
      ),
    ]);
    return { data: rows, total: parseInt(count[0].total), page, limit };
  }
}