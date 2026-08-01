// src/wallet/deposit-expiry.service.ts
//
// Auto-rejects manual deposit requests that have been sitting in the PENDING
// queue longer than DEPOSIT_AUTO_REJECT_MINUTES.
//
// SCOPE — manual/agent deposits only (deposits.provider IS NULL).
//   PSP deposits (WinyPay) are deliberately excluded: their callback is the
//   only thing that knows whether the player actually paid, and the callback
//   handler skips any deposit that is no longer PENDING. Expiring one here
//   would mean a late 'success' callback silently fails to credit a player
//   who already paid.
//
// RECOVERY — an auto-rejected deposit is marked auto_rejected = true and can
//   be pushed back into the queue with POST /wallet/admin/deposits/:id/reopen
//   (needs deposit.approve). A reopened deposit is never expired again
//   (reopened_at IS NOT NULL).
//
// CONFIG — DEPOSIT_AUTO_REJECT_MINUTES:
//   unset / 0 / non-numeric  → feature off (logged once at startup)
//   e.g. 10                  → reject after 10 minutes pending
//
// SCALING NOTE — same as RoundWatcherService: on multiple Node instances every
//   instance runs this tick. That is safe, not just tolerable: decideDeposit
//   takes SELECT … FOR UPDATE on the row and re-checks status inside the
//   transaction, so a loser just gets 'Deposit already REJECTED' and skips.

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { WalletService } from './wallet.service';
import { WalletGateway } from './wallet.gateway';

// Safety rail: if the watcher is switched on for the first time against a
// table full of old PENDING rows, don't reject thousands in one tick.
const MAX_PER_TICK = 200;

@Injectable()
export class DepositExpiryService implements OnModuleInit {
  private readonly logger = new Logger(DepositExpiryService.name);
  private readonly minutes: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly wallet: WalletService,
    private readonly gateway: WalletGateway,
  ) {
    const raw = Number(process.env.DEPOSIT_AUTO_REJECT_MINUTES);
    this.minutes = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  onModuleInit() {
    this.logger.log(
      this.minutes > 0
        ? `Pending-deposit auto-reject ON — manual deposits expire after ${this.minutes} minute(s)`
        : 'Pending-deposit auto-reject OFF (set DEPOSIT_AUTO_REJECT_MINUTES to enable)',
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.minutes <= 0) return;

    try {
      const stale = await this.dataSource.query(
        `SELECT id, user_id, amount, deposit_code, transaction_number
           FROM deposits
          WHERE status = 'PENDING'
            AND provider IS NULL              -- manual/agent deposits only
            AND reopened_at IS NULL           -- an admin already rescued this one
            AND requested_at < NOW() - make_interval(mins => $1::int)
          ORDER BY requested_at ASC
          LIMIT ${MAX_PER_TICK}`,
        [this.minutes],
      );

      if (!stale.length) return;

      const reason = `Auto-rejected — not approved within ${this.minutes} minutes`;

      for (const dep of stale) {
        const depositId = Number(dep.id);
        try {
          await this.wallet.decideDeposit({
            depositId,
            adminId: null,        // system decision — no admin behind it
            action: 'REJECT',
            rejectionReason: reason,
            auto: true,
          });

          this.logger.log(
            `Auto-rejected deposit ${depositId} (${dep.deposit_code}) — pending > ${this.minutes}m`,
          );

          // Refresh open panels. Fire-and-forget: a socket problem must never
          // stop the loop from expiring the rest of the batch.
          this.gateway.pushAdminEvent('admin:deposit-expired', {
            id: depositId,
            refId: `DP${String(depositId).padStart(5, '0')}`,
            userId: Number(dep.user_id),
            amount: parseFloat(dep.amount),
            reference: dep.transaction_number ?? null,
            reason,
          });
          this.gateway.pushUserEvent(Number(dep.user_id), 'deposit:auto-rejected', {
            depositId,
            amount: parseFloat(dep.amount),
            reason,
          });
        } catch (e: any) {
          // Expected loser of a race with an admin decision — log and move on.
          this.logger.warn(`Auto-reject skipped for deposit ${depositId}: ${e.message}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`Pending-deposit sweep failed: ${e.message}`);
    }
  }
}
