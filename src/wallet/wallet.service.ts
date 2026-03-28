import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class WalletService {
  constructor(private dataSource: DataSource) {}

  async getWalletForUpdate(queryRunner, userId: number) {
    const wallet = await queryRunner.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );

    if (!wallet.length) {
      throw new Error('Wallet not found');
    }

    return wallet[0];
  }

  // ---------------- LEDGER INSERT ----------------
   private async insertLedger(queryRunner, data: any) {
    await queryRunner.query(
      `INSERT INTO financial_ledger
      (ledger_code,user_id,wallet_id,entry_type,flow,amount,
       balance_before,balance_after,
       locked_before,locked_after,
       reference_type,reference_id,status,description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        `LEDGER-${Date.now()}`,
        data.userId,
        data.walletId,
        data.entryType,
        data.flow,
        data.amount,
        data.balanceBefore,
        data.balanceAfter,
        data.lockedBefore || 0,
        data.lockedAfter || 0,
        data.referenceType,
        data.referenceId,
        data.status || 'SUCCESS',
        data.description || '',
      ],
    );
  }

  // ---------------- CREDIT (DEPOSIT, WIN, BONUS) ----------------
  async credit(queryRunner, userId: number, amount: number, refType: string, refId: number, entryType: string) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);

    const before = Number(wallet.available_balance);
    const after = before + amount;

    await queryRunner.query(
      `UPDATE wallets
       SET available_balance = $1,
           total_deposit = total_deposit + $2,
           updated_at = NOW()
       WHERE user_id = $3`,
      [after, amount, userId],
    );

    await this.insertLedger(queryRunner, {
      userId,
      walletId: wallet.id,
      entryType,
      flow: 'CREDIT',
      amount,
      balanceBefore: before,
      balanceAfter: after,
      referenceType: refType,
      referenceId: refId,
    });
  }

  // ---------------- LOCK (WITHDRAW REQUEST) ----------------
  async lockAmount(queryRunner, userId: number, amount: number, refId: number) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);

    const available = Number(wallet.available_balance);

    if (available < amount) {
      throw new Error('Insufficient balance');
    }

    const locked = Number(wallet.locked_balance);

    await queryRunner.query(
      `UPDATE wallets
       SET available_balance = $1,
           locked_balance = $2,
           updated_at = NOW()
       WHERE user_id = $3`,
      [available - amount, locked + amount, userId],
    );

    await this.insertLedger(queryRunner, {
      userId,
      walletId: wallet.id,
      entryType: 'WITHDRAWAL_REQUESTED',
      flow: 'LOCK',
      amount,
      balanceBefore: available,
      balanceAfter: available - amount,
      lockedBefore: locked,
      lockedAfter: locked + amount,
      referenceType: 'WITHDRAWAL',
      referenceId: refId,
    });
  }

  // ---------------- FINAL WITHDRAW ----------------
  async debitLocked(queryRunner, userId: number, amount: number, refId: number) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);

    const locked = Number(wallet.locked_balance);

    if (locked < amount) {
      throw new Error('Invalid locked balance');
    }

    await queryRunner.query(
      `UPDATE wallets
       SET locked_balance = $1,
           total_withdrawal = total_withdrawal + $2,
           updated_at = NOW()
       WHERE user_id = $3`,
      [locked - amount, amount, userId],
    );

    await this.insertLedger(queryRunner, {
      userId,
      walletId: wallet.id,
      entryType: 'WITHDRAWAL_APPROVED',
      flow: 'DEBIT',
      amount,
      balanceBefore: wallet.available_balance,
      balanceAfter: wallet.available_balance,
      lockedBefore: locked,
      lockedAfter: locked - amount,
      referenceType: 'WITHDRAWAL',
      referenceId: refId,
    });
  }

  // ---------------- RELEASE (WITHDRAW REJECT) ----------------
  async releaseLocked(queryRunner, userId: number, amount: number, refId: number) {
    const wallet = await this.getWalletForUpdate(queryRunner, userId);

    const available = Number(wallet.available_balance);
    const locked = Number(wallet.locked_balance);

    await queryRunner.query(
      `UPDATE wallets
       SET available_balance = $1,
           locked_balance = $2,
           updated_at = NOW()
       WHERE user_id = $3`,
      [available + amount, locked - amount, userId],
    );

    await this.insertLedger(queryRunner, {
      userId,
      walletId: wallet.id,
      entryType: 'WITHDRAWAL_REJECTED',
      flow: 'RELEASE',
      amount,
      balanceBefore: available,
      balanceAfter: available + amount,
      lockedBefore: locked,
      lockedAfter: locked - amount,
      referenceType: 'WITHDRAWAL',
      referenceId: refId,
    });
  }
}