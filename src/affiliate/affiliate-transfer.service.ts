// src/affiliate/affiliate-transfer.service.ts
//
// Affiliate → player commission transfers (Figma affiliate panel "Transfer"
// + admin panel "Transfer requests"):
//
//   • The affiliate sends part of their commission_balance to any player
//     account. The amount is held (deducted) immediately on request.
//   • Admin approves → the player's REAL wallet balance is credited and a
//     financial_ledger row (AFFILIATE_COMMISSION_CREDIT) makes it show up in
//     the player's transaction history.
//   • Admin rejects → the held amount is refunded to the affiliate.
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { assertUserActive } from '../common/account-status.util';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { WalletGateway } from '../wallet/wallet.gateway';
import { TurnoverService } from '../turnover/turnover.service';

// Minimum amount an affiliate can transfer to a player in one request.
const MIN_TRANSFER_AMOUNT = 200;

@Injectable()
export class AffiliateTransferService {
  constructor(
    private dataSource: DataSource,
    private financialLedger: FinancialLedgerService,
    private walletGateway: WalletGateway,
    private turnoverService: TurnoverService,
  ) {}

  // Display code derived from id (same pattern as dp_id / wd_id).
  private codeFor(id: number): string {
    return `TR-${1000 + Number(id)}`;
  }

  // ═════════════════════════════════════════════════════════════
  // AFFILIATE: request a transfer to a player account
  // ═════════════════════════════════════════════════════════════
  async requestTransfer(
    userId: number,
    dto: { recipient: string; amount: number; note?: string },
  ) {
    const amount = Math.round(Number(dto.amount) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('amount must be a positive number');
    }
    if (amount < MIN_TRANSFER_AMOUNT) {
      throw new BadRequestException(
        `Minimum transfer amount is ${MIN_TRANSFER_AMOUNT.toFixed(2)}`,
      );
    }
    if (!dto.recipient || !String(dto.recipient).trim()) {
      throw new BadRequestException('recipient is required (user ID / user code / username)');
    }

    const afRows = await this.dataSource.query(
      `SELECT au.id, au.user_id, au.status, au.is_active, u.user_code
         FROM affiliate_users au JOIN users u ON u.id = au.user_id
        WHERE au.user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!afRows.length) throw new ForbiddenException('You are not an affiliate');
    // The affiliate's own player account must be in good standing — a
    // suspended player cannot move commission into their wallet.
    await assertUserActive(this.dataSource, userId);
    const af = afRows[0];
    if (!af.is_active || af.status !== 'ACTIVE') {
      throw new ForbiddenException(`Your affiliate account is ${af.status ?? 'inactive'}`);
    }

    // Resolve the recipient by user_code, username, or numeric users.id.
    const ref = String(dto.recipient).trim();
    const recRows = await this.dataSource.query(
      `SELECT id, user_code, username, account_status
         FROM users
        WHERE user_code = UPPER($1) OR username = $1
           OR ($2::bigint IS NOT NULL AND id = $2::bigint)
        LIMIT 1`,
      [ref, /^\d+$/.test(ref) ? Number(ref) : null],
    );
    if (!recRows.length) throw new NotFoundException(`Recipient "${ref}" not found`);
    const recipient = recRows[0];
    if (Number(recipient.id) === Number(userId)) {
      throw new BadRequestException('You cannot transfer to your own account');
    }
    if (recipient.account_status !== 'ACTIVE') {
      throw new BadRequestException(`Recipient account is ${recipient.account_status}`);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const balRows = await qr.query(
        `SELECT commission_balance FROM affiliate_users WHERE id = $1 FOR UPDATE`,
        [af.id],
      );
      const before = parseFloat(balRows[0].commission_balance);
      if (before < amount) {
        throw new BadRequestException(
          `Insufficient commission balance. Available: ${before.toFixed(2)}`,
        );
      }
      const after = Math.round((before - amount) * 100) / 100;

      await qr.query(
        `UPDATE affiliate_users SET commission_balance = $1, updated_at = NOW() WHERE id = $2`,
        [after, af.id],
      );

      const trRows = await qr.query(
        `INSERT INTO affiliate_transfers
           (affiliate_user_id, from_user_id, to_user_id, amount, note, status)
         VALUES ($1,$2,$3,$4,$5,'PENDING')
         RETURNING id, requested_at`,
        [af.id, userId, recipient.id, amount, dto.note ?? null],
      );
      const transferId = Number(trRows[0].id);

      await qr.query(
        `INSERT INTO affiliate_commission_ledger
           (affiliate_user_id, entry_type, flow, amount, balance_before, balance_after,
            reference_type, reference_id, description)
         VALUES ($1,'TRANSFER_REQUEST','DEBIT',$2,$3,$4,'AFFILIATE_TRANSFER',$5,$6)`,
        [
          af.id, amount, before, after, transferId,
          `Transfer request ${this.codeFor(transferId)} to ${recipient.user_code}`,
        ],
      );

      await qr.commitTransaction();

      return {
        message: 'Transfer request submitted. Awaiting admin approval.',
        transfer: {
          id: transferId,
          code: this.codeFor(transferId),
          recipient: {
            userId: Number(recipient.id),
            userCode: recipient.user_code,
            username: recipient.username,
          },
          amount,
          status: 'PENDING',
          requestedAt: trRows[0].requested_at,
        },
        commissionBalance: after,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // AFFILIATE: my transfer history
  // ═════════════════════════════════════════════════════════════
  async getMyTransfers(userId: number, page = 1, limit = 20, status?: string) {
    const afRows = await this.dataSource.query(
      `SELECT id FROM affiliate_users WHERE user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!afRows.length) throw new ForbiddenException('You are not an affiliate');
    const affiliateUserId = afRows[0].id;
    const offset = (page - 1) * limit;

    const statusFilter =
      status && ['PENDING', 'APPROVED', 'REJECTED'].includes(status.toUpperCase())
        ? status.toUpperCase()
        : null;

    // A transfer-status filter narrows to transfers only (admin adjustments
    // have no PENDING/APPROVED/REJECTED status).
    if (statusFilter) {
      const [rows, count] = await Promise.all([
        this.dataSource.query(
          `SELECT t.id, t.amount, t.status, t.note, t.rejection_reason,
                  t.requested_at, t.decided_at,
                  ru.user_code AS recipient_code, ru.username AS recipient_username
             FROM affiliate_transfers t
             JOIN users ru ON ru.id = t.to_user_id
            WHERE t.affiliate_user_id = $1 AND t.status = $2
            ORDER BY t.requested_at DESC
            LIMIT $3 OFFSET $4`,
          [affiliateUserId, statusFilter, limit, offset],
        ),
        this.dataSource.query(
          `SELECT COUNT(*)::int AS total FROM affiliate_transfers
            WHERE affiliate_user_id = $1 AND status = $2`,
          [affiliateUserId, statusFilter],
        ),
      ]);
      return {
        data: rows.map((r: any) => ({
          ...r, type: 'TRANSFER', code: this.codeFor(Number(r.id)), amount: parseFloat(r.amount),
        })),
        total: count[0].total,
        page,
        limit,
      };
    }

    // No filter → merged feed: transfers + admin commission ADJUSTMENTS
    // (credits/debits), newest-first. Each row is tagged with `type`; adjustment
    // rows carry the admin remark (`remark`) and which admin made it.
    const [rows, count] = await Promise.all([
      this.dataSource.query(
        `SELECT * FROM (
           SELECT t.id, 'TRANSFER' AS type, t.amount, 'DEBIT' AS flow, t.status,
                  t.note AS remark, t.rejection_reason, t.requested_at AS created_at,
                  ru.user_code AS recipient_code, ru.username AS recipient_username,
                  NULL::text AS admin_name, NULL::text AS admin_email
             FROM affiliate_transfers t
             JOIN users ru ON ru.id = t.to_user_id
            WHERE t.affiliate_user_id = $1
           UNION ALL
           SELECT acl.id, 'ADJUSTMENT' AS type, acl.amount, acl.flow, NULL AS status,
                  acl.description AS remark, NULL AS rejection_reason, acl.created_at,
                  NULL AS recipient_code, NULL AS recipient_username,
                  a.name AS admin_name, a.email AS admin_email
             FROM affiliate_commission_ledger acl
             LEFT JOIN admin_users a
               ON acl.reference_type = 'ADMIN' AND a.id = acl.reference_id
            WHERE acl.affiliate_user_id = $1 AND acl.entry_type = 'ADMIN_ADJUST'
         ) feed
         ORDER BY created_at DESC, id DESC
         LIMIT $2 OFFSET $3`,
        [affiliateUserId, limit, offset],
      ),
      this.dataSource.query(
        `SELECT (
            (SELECT COUNT(*) FROM affiliate_transfers WHERE affiliate_user_id = $1)
          + (SELECT COUNT(*) FROM affiliate_commission_ledger
              WHERE affiliate_user_id = $1 AND entry_type = 'ADMIN_ADJUST')
         )::int AS total`,
        [affiliateUserId],
      ),
    ]);

    return {
      data: rows.map((r: any) => ({
        ...r,
        amount: parseFloat(r.amount),
        // Transfer display code (TR-xxxx); adjustments have none.
        code: r.type === 'TRANSFER' ? this.codeFor(Number(r.id)) : null,
      })),
      total: count[0].total,
      page,
      limit,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: list transfer requests (+ status counts for the KPI cards)
  // ═════════════════════════════════════════════════════════════
  async adminListTransfers(
    opts: { status?: string; q?: string; from?: string; to?: string; page?: number; limit?: number } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];
    if (opts.status && ['PENDING', 'APPROVED', 'REJECTED'].includes(opts.status.toUpperCase())) {
      params.push(opts.status.toUpperCase());
      where.push(`t.status = $${params.length}`);
    }
    if (opts.q?.trim()) {
      params.push(`%${opts.q.trim()}%`);
      where.push(`(fu.username ILIKE $${params.length} OR fu.user_code ILIKE $${params.length}
                   OR ru.username ILIKE $${params.length} OR ru.user_code ILIKE $${params.length})`);
    }
    if (opts.from) {
      params.push(opts.from);
      where.push(`t.requested_at >= $${params.length}::date`);
    }
    if (opts.to) {
      params.push(opts.to);
      where.push(`t.requested_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, count, stats] = await Promise.all([
      this.dataSource.query(
        `SELECT t.id, t.amount, t.status, t.note, t.rejection_reason,
                t.requested_at, t.decided_at, t.decided_by_admin_id,
                fu.id AS from_user_id, fu.user_code AS from_code, fu.username AS from_username,
                ru.id AS to_user_id, ru.user_code AS recipient_code, ru.username AS recipient_username
           FROM affiliate_transfers t
           JOIN users fu ON fu.id = t.from_user_id
           JOIN users ru ON ru.id = t.to_user_id
           ${whereSql}
           ORDER BY (t.status = 'PENDING') DESC, t.requested_at DESC
           LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*)::int AS total
           FROM affiliate_transfers t
           JOIN users fu ON fu.id = t.from_user_id
           JOIN users ru ON ru.id = t.to_user_id
           ${whereSql}`,
        params,
      ),
      this.dataSource.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'PENDING')::int  AS pending,
           COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
           COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
         FROM affiliate_transfers`,
      ),
    ]);

    return {
      stats: stats[0],
      data: rows.map((r: any) => ({ ...r, code: this.codeFor(r.id), amount: parseFloat(r.amount) })),
      total: count[0].total,
      page,
      limit,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: approve / reject a transfer
  // ═════════════════════════════════════════════════════════════
  async decideTransfer(
    transferId: number,
    adminId: number,
    action: 'APPROVE' | 'REJECT',
    rejectionReason?: string,
    // Optional turnover multiplier applied to the credited amount on APPROVE.
    // Blank/undefined → 1× (recipient must wager the amount once). 0 → no
    // turnover (freely withdrawable). Ignored on REJECT.
    turnoverMultiplier?: number,
  ) {
    if (action !== 'APPROVE' && action !== 'REJECT') {
      throw new BadRequestException("action must be 'APPROVE' or 'REJECT'");
    }
    // Resolve the turnover multiplier: default 1×, never negative.
    const rawMult = Number(turnoverMultiplier);
    const multiplier = Number.isFinite(rawMult) && rawMult >= 0 ? rawMult : 1;

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    let approvedRecipientId: number | null = null;
    try {
      const trRows = await qr.query(
        `SELECT t.*, fu.user_code AS from_code
           FROM affiliate_transfers t
           JOIN users fu ON fu.id = t.from_user_id
          WHERE t.id = $1 FOR UPDATE OF t`,
        [transferId],
      );
      if (!trRows.length) throw new NotFoundException('Transfer not found');
      const tr = trRows[0];
      if (tr.status !== 'PENDING') {
        throw new BadRequestException(`Transfer already ${tr.status}`);
      }
      const amount = parseFloat(tr.amount);

      if (action === 'APPROVE') {
        const walletRows = await qr.query(
          `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
          [tr.to_user_id],
        );
        if (!walletRows.length) throw new NotFoundException('Recipient wallet not found');
        const wallet = walletRows[0];
        const bal = parseFloat(wallet.balance);
        const bon = parseFloat(wallet.bonus_balance);
        const lck = parseFloat(wallet.locked_balance);
        const newBal = Math.round((bal + amount) * 100) / 100;

        await qr.query(
          `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
          [newBal, wallet.id],
        );

        const ledgerId = await this.financialLedger.write({
          qr,
          walletId: wallet.id,
          userId: Number(tr.to_user_id),
          entryType: 'AFFILIATE_COMMISSION_CREDIT',
          flow: 'CREDIT',
          amount,
          balanceBefore: bal,
          balanceAfter: newBal,
          bonusBefore: bon,
          bonusAfter: bon,
          lockedBefore: lck,
          lockedAfter: lck,
          referenceType: 'AFFILIATE_TRANSFER',
          referenceId: transferId,
          status: 'SUCCESS',
          description: `Affiliate commission transfer ${this.codeFor(transferId)} from ${tr.from_code}`,
          createdByType: 'ADMIN',
          createdById: adminId,
        });

        await qr.query(
          `UPDATE affiliate_transfers
              SET status = 'APPROVED', decided_at = NOW(), decided_by_admin_id = $1,
                  ledger_id = $2, updated_at = NOW()
            WHERE id = $3`,
          [adminId, ledgerId, transferId],
        );

        // Turnover: the credited amount carries a wagering requirement (like
        // the referral bonus). multiplier 0 → skip (freely withdrawable).
        if (multiplier > 0) {
          const targetAmount = Math.round(amount * multiplier * 100) / 100;
          await this.turnoverService.insertRequirement(qr, {
            userId: Number(tr.to_user_id),
            sourceType: 'BONUS',
            sourceId: transferId,
            baseAmount: amount,
            multiplier,
            targetAmount,
            adminId,
            label: `Affiliate commission ${this.codeFor(transferId)} from ${tr.from_code}`,
          });
        }

        approvedRecipientId = Number(tr.to_user_id);
      } else {
        // Refund the held amount back to the affiliate's commission balance.
        const balRows = await qr.query(
          `SELECT commission_balance FROM affiliate_users WHERE id = $1 FOR UPDATE`,
          [tr.affiliate_user_id],
        );
        const before = parseFloat(balRows[0].commission_balance);
        const after = Math.round((before + amount) * 100) / 100;
        await qr.query(
          `UPDATE affiliate_users SET commission_balance = $1, updated_at = NOW() WHERE id = $2`,
          [after, tr.affiliate_user_id],
        );
        await qr.query(
          `INSERT INTO affiliate_commission_ledger
             (affiliate_user_id, entry_type, flow, amount, balance_before, balance_after,
              reference_type, reference_id, description)
           VALUES ($1,'TRANSFER_REFUND','CREDIT',$2,$3,$4,'AFFILIATE_TRANSFER',$5,$6)`,
          [
            tr.affiliate_user_id, amount, before, after, transferId,
            `Transfer ${this.codeFor(transferId)} rejected${rejectionReason ? `: ${rejectionReason}` : ''}`,
          ],
        );
        await qr.query(
          `UPDATE affiliate_transfers
              SET status = 'REJECTED', decided_at = NOW(), decided_by_admin_id = $1,
                  rejection_reason = $2, updated_at = NOW()
            WHERE id = $3`,
          [adminId, rejectionReason ?? null, transferId],
        );
      }

      await qr.commitTransaction();
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    // Push the live balance to the recipient after the commit (best-effort).
    if (approvedRecipientId != null) {
      void this.walletGateway.pushBalanceUpdate(approvedRecipientId);
    }

    return {
      message: `Transfer ${action === 'APPROVE' ? 'approved — recipient credited' : 'rejected — amount refunded to affiliate'}.`,
      transferId,
      code: this.codeFor(transferId),
      status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    };
  }
}
