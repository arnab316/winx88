import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { VipService } from 'src/vip/vip.service';

/**
 * Deposits and withdrawals — "where is my money?".
 *
 * There is no existing per-customer deposit or withdrawal reader to reuse:
 * the player app only has the merged ledger feed, and the detailed lists are
 * admin endpoints that take any user id. These queries are therefore new, but
 * they are READS ONLY — every rule about whether a payment is allowed still
 * lives in WalletService, and nothing here re-implements one.
 *
 * Internal columns are never returned: `approved_by_admin_id`, screenshots,
 * provider transaction ids and the agent a deposit was routed to all stay out.
 */
@Injectable()
export class AiSupportPaymentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly vip: VipService,
  ) {}

  // ── deposits ───────────────────────────────────────────────────────

  async listDeposits(
    userId: number,
    page = 1,
    limit = 20,
    status?: string,
    transactionNumber?: string,
  ) {
    const offset = (page - 1) * limit;
    const params: any[] = [userId];
    let clause = 'WHERE d.user_id = $1';
    if (status) {
      params.push(status.toUpperCase());
      clause += ` AND d.status = $${params.length}`;
    }
    if (transactionNumber?.trim()) {
      // Customers paste TRX ids with stray spaces and mixed case. Normalising
      // both sides is lookup convenience, not a rule change.
      params.push(transactionNumber.trim());
      clause += ` AND UPPER(TRIM(d.transaction_number)) = UPPER(TRIM($${params.length}))`;
    }

    const [rows, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT d.id, d.deposit_code, d.transaction_number, d.amount, d.status,
                d.requested_at, d.decided_at, d.rejection_reason,
                d.created_at, d.updated_at, d.provider, g.name AS gateway_name
           FROM deposits d
           LEFT JOIN payment_gateways g ON g.id = d.gateway_id
           ${clause}
          ORDER BY d.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM deposits d ${clause}`,
        params,
      ),
    ]);

    return {
      data: rows.map((r: any) => this.shapeDeposit(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  /**
   * One deposit. Scoped by user_id in the WHERE clause, not checked after
   * loading — a missing row and someone else's row must be indistinguishable,
   * or the 404/403 difference tells an attacker which ids exist.
   */
  async getDeposit(userId: number, depositId: number) {
    const [row] = await this.dataSource.query(
      `SELECT d.id, d.deposit_code, d.transaction_number, d.amount, d.status,
              d.requested_at, d.decided_at, d.rejection_reason,
              d.created_at, d.updated_at, d.provider, g.name AS gateway_name
         FROM deposits d
         LEFT JOIN payment_gateways g ON g.id = d.gateway_id
        WHERE d.id = $1 AND d.user_id = $2
        LIMIT 1`,
      [depositId, userId],
    );
    if (!row) throw new NotFoundException('Deposit not found');
    return this.shapeDeposit(row);
  }

  /**
   * Find a deposit by the TRX id the customer entered.
   *
   * Returns a LIST, not one row: `transaction_number` has no uniqueness
   * constraint, so a customer can legitimately have two rows carrying the
   * same reference (a resubmitted deposit, or a typo reused). Returning the
   * first would hide the other from the agent looking for it.
   *
   * Scoped to this customer, so a TRX id belonging to someone else simply
   * returns nothing rather than confirming it exists.
   */
  async findDepositsByTransaction(userId: number, transactionNumber: string) {
    const res = await this.listDeposits(userId, 1, 20, undefined, transactionNumber);
    return {
      transactionNumber: transactionNumber.trim(),
      found: res.total > 0,
      total: res.total,
      data: res.data,
      customerMessage:
        res.total === 0
          ? 'No deposit on this account carries that transaction id. Check the number, or it may have been sent from a different account.'
          : res.total === 1
            ? res.data[0].customerMessage
            : `${res.total} deposits on this account carry that transaction id.`,
    };
  }

  private shapeDeposit(r: any) {
    const status = String(r.status ?? '').toUpperCase();
    return {
      depositId: Number(r.id),
      reference: r.deposit_code ?? `DP${r.id}`,
      // What the customer typed when sending the money — the number they
      // will quote to support. For automated (provider) deposits this is the
      // generated order id instead, which is why isAutomated sits beside it.
      transactionNumber: r.transaction_number ?? null,
      amount: Number(r.amount),
      status,
      // The channel category, not the agent account the money went to.
      paymentMethod: r.gateway_name ?? r.provider ?? null,
      isAutomated: !!r.provider,
      requestedAt: r.requested_at ?? r.created_at,
      decidedAt: r.decided_at ?? null,
      updatedAt: r.updated_at ?? null,
      // Written by an admin for the customer, so safe to relay verbatim.
      rejectionReason: status === 'REJECTED' ? (r.rejection_reason ?? null) : null,
      customerMessage: this.depositMessage(status, r.rejection_reason),
    };
  }

  private depositMessage(status: string, reason?: string | null): string {
    switch (status) {
      case 'PENDING':
        return 'This deposit is waiting to be checked by our payments team.';
      case 'APPROVED':
        return 'This deposit was approved and added to the balance.';
      case 'REJECTED':
        return reason
          ? `This deposit was rejected. Reason given: ${reason}`
          : 'This deposit was rejected. No reason was recorded — support can review it.';
      default:
        return `This deposit is ${status}.`;
    }
  }

  // ── withdrawals ────────────────────────────────────────────────────

  async listWithdrawals(userId: number, page = 1, limit = 20, status?: string) {
    const offset = (page - 1) * limit;
    const params: any[] = [userId];
    let clause = 'WHERE w.user_id = $1';
    if (status) {
      params.push(status.toUpperCase());
      clause += ` AND w.status = $${params.length}`;
    }

    const [rows, [{ total }]] = await Promise.all([
      this.dataSource.query(
        `SELECT w.id, w.withdrawal_code, w.amount, w.status, w.requested_at,
                w.decided_at, w.rejection_reason, w.created_at, w.updated_at,
                g.name AS gateway_name
           FROM withdrawals w
           LEFT JOIN payment_gateways g ON g.id = w.gateway_id
           ${clause}
          ORDER BY w.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total FROM withdrawals w ${clause}`,
        params,
      ),
    ]);

    return {
      data: rows.map((r: any) => this.shapeWithdrawal(r)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  async getWithdrawal(userId: number, withdrawalId: number) {
    const [row] = await this.dataSource.query(
      `SELECT w.id, w.withdrawal_code, w.amount, w.status, w.requested_at,
              w.decided_at, w.rejection_reason, w.created_at, w.updated_at,
              g.name AS gateway_name
         FROM withdrawals w
         LEFT JOIN payment_gateways g ON g.id = w.gateway_id
        WHERE w.id = $1 AND w.user_id = $2
        LIMIT 1`,
      [withdrawalId, userId],
    );
    if (!row) throw new NotFoundException('Withdrawal not found');
    return this.shapeWithdrawal(row);
  }

  private shapeWithdrawal(r: any) {
    const status = String(r.status ?? '').toUpperCase();
    return {
      withdrawalId: Number(r.id),
      // The admin list uses withdrawal_code as the customer-visible TRX id.
      reference: r.withdrawal_code ?? `WD${r.id}`,
      amount: Number(r.amount),
      status,
      paymentMethod: r.gateway_name ?? null,
      requestedAt: r.requested_at ?? r.created_at,
      decidedAt: r.decided_at ?? null,
      updatedAt: r.updated_at ?? null,
      rejectionReason: status === 'REJECTED' ? (r.rejection_reason ?? null) : null,
      customerMessage: this.withdrawalMessage(status, r.rejection_reason),
    };
  }

  private withdrawalMessage(status: string, reason?: string | null): string {
    switch (status) {
      case 'PENDING':
        return 'This withdrawal is queued for processing.';
      case 'APPROVED':
        return 'This withdrawal was approved and sent.';
      case 'REJECTED':
        return reason
          ? `This withdrawal was rejected. Reason given: ${reason}`
          : 'This withdrawal was rejected. No reason was recorded — support can review it.';
      default:
        return `This withdrawal is ${status}.`;
    }
  }

  /**
   * Can this customer withdraw right now, and if not, why.
   *
   * Reports the SAME conditions WalletService.requestWithdrawal enforces,
   * read from the same configuration — it does not re-decide anything. A
   * request is still accepted or refused by the wallet service alone, so a
   * disagreement here is a reporting bug, never a money bug.
   */
  async getWithdrawalEligibility(userId: number) {
    const [u] = await this.dataSource.query(
      `SELECT u.account_status, u.vip_level, w.balance,
              uv.status AS kyc_status
         FROM users u
         LEFT JOIN wallets w ON w.user_id = u.id
         LEFT JOIN user_verifications uv ON uv.user_id = u.id
        WHERE u.id = $1 LIMIT 1`,
      [userId],
    );
    if (!u) throw new NotFoundException('Customer not found');

    const blockers: Array<{ code: string; message: string }> = [];

    if (String(u.account_status).toUpperCase() !== 'ACTIVE') {
      blockers.push({
        code: 'ACCOUNT_NOT_ACTIVE',
        message: `The account is ${u.account_status}.`,
      });
    }

    const [turn] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS n,
              COALESCE(SUM(target_amount - current_amount), 0) AS remaining
         FROM turnover_requirements
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );
    if (Number(turn?.n ?? 0) > 0) {
      blockers.push({
        code: 'TURNOVER_PENDING',
        message:
          `A wagering requirement is still active. ` +
          `${Number(turn.remaining)} of turnover remains before withdrawing.`,
      });
    }

    // Tier limits are CONFIGURATION, read here and enforced in WalletService.
    const [limits] = await this.dataSource.query(
      `SELECT withdrawal_min, withdrawal_max,
              withdrawal_daily_count, withdrawal_daily_max
         FROM vip_level_config WHERE level = $1`,
      [Number(u.vip_level ?? 0)],
    );

    let banking: any = null;
    try {
      banking = await this.vip.getBankingToggles(Number(u.vip_level ?? 0));
    } catch {
      banking = null;
    }
    if (banking?.withdrawalEnabled === false) {
      blockers.push({
        code: 'WITHDRAWAL_DISABLED_FOR_TIER',
        message: 'Withdrawals are currently unavailable for this account tier.',
      });
    }

    const num = (v: any) => (v == null ? null : Number(v));
    return {
      customerId: userId,
      eligible: blockers.length === 0,
      blockers,
      balance: Number(u.balance ?? 0),
      kycStatus: u.kyc_status ?? 'NOT_SUBMITTED',
      // A limit of 0 or null means "not configured", matching how
      // WalletService treats it — it only enforces a limit greater than zero.
      // Mirrors exactly the columns WalletService.getTierLimits reads.
      limits: {
        min: num(limits?.withdrawal_min),
        max: num(limits?.withdrawal_max),
        dailyCount: num(limits?.withdrawal_daily_count),
        dailyMax: num(limits?.withdrawal_daily_max),
        note: 'A null or zero limit means no limit is configured for this tier.',
      },
      enabledChannels:
        banking?.channels
          ?.filter((c: any) => c.withdrawalEnabled)
          .map((c: any) => c.channel) ?? null,
    };
  }
}
