// src/turnover/turnover.service.ts
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { TurnoverLedgerService } from '../ledger/turnover-ledger.service';
import { ReferralEngineService } from '../referral/referral-engine.service';
import {
  AdminAdjustTurnoverDto,
  AdminCancelTurnoverDto,
  AdminCreateTurnoverDto,
} from './dto/turnover.dto';

/**
 * Single Responsibility: manage turnover_requirements + write turnover_ledger.
 *
 * BUSINESS RULES (per design Q&A):
 *   - Default multiplier for plain deposits = 0 (no req created)
 *   - Promotion deposits → req with multiplier from promotion config
 *   - All bet types contribute to turnover (no game weighting yet)
 *   - Turnover progresses ONLY when a bet is SETTLED (won or lost)
 *   - Bets consume from OLDEST active req first (FIFO)
 *   - On withdrawal request → BLOCK if ANY active req exists
 *   - On withdrawal approval → RESET ALL active reqs to zero (archive)
 */
@Injectable()
export class TurnoverService {
  constructor(
    private dataSource: DataSource,
    private turnoverLedger: TurnoverLedgerService,
    private referralEngine: ReferralEngineService,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // CREATE FROM DEPOSIT
  //   Called from wallet.decideDeposit() on APPROVE.
  //   Skips entirely if no promotion attached.
  // ═════════════════════════════════════════════════════════════
  // Default turnover multiplier applied to a plain deposit (no promotion).
  // Client rule: a deposit with no promo still carries a 1× turnover
  // requirement, e.g. deposit 1000 → 1000 turnover to clear.
  static readonly DEFAULT_DEPOSIT_MULTIPLIER = 1;

  async createFromDeposit(
  qr: any /* QueryRunner */,
  userId: number,
  depositId: number,
  depositAmount: number,
  promotionId: number | null,
): Promise<{ requirementId: number; targetAmount: number } | null> {
  // ── Plain deposit (no promotion) → default 1× turnover ──────────────
  // A multiplier of 0 would mean "no requirement"; the default is 1, so a
  // plain deposit always creates a requirement of (amount × 1).
  if (!promotionId) {
    const multiplier = TurnoverService.DEFAULT_DEPOSIT_MULTIPLIER;
    if (!multiplier || multiplier <= 0 || depositAmount <= 0) return null;
    return this.insertRequirement(qr, {
      userId,
      sourceType: 'DEPOSIT',
      sourceId: depositId,
      baseAmount: depositAmount,
      multiplier,
      targetAmount: depositAmount * multiplier,
      label: 'Deposit turnover',
    });
  }

  const promo = await qr.query(
    `SELECT id, rollover_multiplier, bonus_type, bonus_value,
            min_amount, max_bonus, is_active
     FROM promotions
     WHERE id = $1`,
    [promotionId],
  );
  if (!promo.length) return null;

  const p = promo[0];
  if (!p.is_active) return null;

  const multiplier = parseFloat(p.rollover_multiplier ?? '0');
  if (!multiplier || multiplier <= 0) return null;

  // Recompute the bonus that was issued, matching engine logic
  let bonus = 0;
  const bonusValue = parseFloat(p.bonus_value ?? '0');

  if (p.bonus_type === 'FLAT') {
    bonus = bonusValue;
  } else if (p.bonus_type === 'PERCENT') {
    bonus = depositAmount * (bonusValue / 100);
  }

  // Cap by max_bonus
  if (p.max_bonus && bonus > parseFloat(p.max_bonus)) {
    bonus = parseFloat(p.max_bonus);
  }

  const baseAmount = depositAmount + bonus;
  const targetAmount = baseAmount * multiplier;

  return this.insertRequirement(qr, {
    userId,
    sourceType: 'DEPOSIT',
    sourceId: depositId,
    baseAmount,
    multiplier,
    targetAmount,
    label: 'Deposit bonus turnover',
  });
}


  // ═════════════════════════════════════════════════════════════
  // CONTRIBUTE FROM SETTLED BET
  //   Called from game.settleRound() AFTER a bet has been resolved.
  //   Both WON and LOST bets contribute their bet_amount.
  //   Distributes across active reqs FIFO (oldest first).
  // ═════════════════════════════════════════════════════════════
  async contributeFromSettledBet(
    qr: QueryRunner,
    userId: number,
    betId: number,
    betAmount: number,
  ): Promise<void> {
    // Refer-a-friend turnover/bonus-wagering progress. Self-isolated via a
    // SAVEPOINT inside the engine, so it can't break this bet settlement. Runs
    // before the turnover-requirements work so it fires even when there are none.
    await this.referralEngine.onBetSettled(qr, userId, betAmount);

    const reqs = await qr.query(
      `SELECT id, target_amount, current_amount
       FROM turnover_requirements
       WHERE user_id = $1 AND status = 'ACTIVE'
       ORDER BY created_at ASC, id ASC
       FOR UPDATE`,
      [userId],
    );

    if (!reqs.length) return;

    let remaining = betAmount;

    for (const req of reqs) {
      if (remaining <= 0) break;

      const target  = parseFloat(req.target_amount);
      const current = parseFloat(req.current_amount);
      const needed  = target - current;

      if (needed <= 0) continue;

      const contribution = Math.min(remaining, needed);
      const newAmount = current + contribution;
      const completed = newAmount >= target;

      await qr.query(
        `UPDATE turnover_requirements
         SET current_amount = $1,
             status = $2,
             completed_at = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [
          newAmount,
          completed ? 'COMPLETED' : 'ACTIVE',
          completed ? new Date() : null,
          req.id,
        ],
      );

      await this.turnoverLedger.write({
        qr,
        userId,
        requirementId: req.id,
        eventType:     'CONTRIBUTION',
        amount:        contribution,
        balanceBefore: current,
        balanceAfter:  newAmount,
        referenceType: 'BET',
        referenceId:   betId,
        description:   `Settled bet contributed ${contribution} toward turnover`,
      });

      if (completed) {
        await this.turnoverLedger.write({
          qr,
          userId,
          requirementId: req.id,
          eventType:     'COMPLETED',
          amount:        0,
          balanceBefore: newAmount,
          balanceAfter:  newAmount,
          referenceType: 'BET',
          referenceId:   betId,
          description:   `Turnover requirement completed`,
        });
      }

      remaining -= contribution;
    }
    // Excess (remaining > 0) is dropped — each req is a closed contract.

    // After this bet, if the wallet is wagered down to ~empty (≤ 1) there is
    // nothing left to cash out, so any remaining turnover lock is pointless —
    // auto-complete the user's other still-ACTIVE requirements.
    await this.completeAllIfWalletDepleted(qr, userId, betId);
  }

  // ═════════════════════════════════════════════════════════════
  // AUTO-COMPLETE WHEN WALLET IS DEPLETED
  //   If the user's wallet balance has dropped to 0 or 1, complete ALL their
  //   remaining ACTIVE turnover requirements: there's no balance left to
  //   withdraw, so holding them behind a wagering gate serves no purpose.
  //   Runs inside the settled-bet transaction; idempotent (no ACTIVE rows → no-op).
  // ═════════════════════════════════════════════════════════════
  private async completeAllIfWalletDepleted(
    qr: QueryRunner,
    userId: number,
    betId: number,
  ): Promise<void> {
    const [w] = await qr.query(
      `SELECT balance FROM wallets WHERE user_id = $1`,
      [userId],
    );
    if (!w || parseFloat(w.balance) > 1) return;

    const active = await qr.query(
      `SELECT id, current_amount, target_amount
         FROM turnover_requirements
        WHERE user_id = $1 AND status = 'ACTIVE'
        FOR UPDATE`,
      [userId],
    );
    if (!active.length) return;

    // Only flip the status — keep current_amount at what the player ACTUALLY
    // wagered. (Previously this overwrote current_amount = target_amount, so the
    // wagering page showed a completed requirement at its full target even
    // though the player never wagered that much.)
    await qr.query(
      `UPDATE turnover_requirements
          SET status = 'COMPLETED',
              completed_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );

    for (const r of active) {
      const current = parseFloat(r.current_amount);
      await this.turnoverLedger.write({
        qr,
        userId,
        requirementId: Number(r.id),
        eventType:     'COMPLETED',
        amount:        0, // administrative completion — no real turnover added
        balanceBefore: current,
        balanceAfter:  current,
        referenceType: 'BET',
        referenceId:   betId,
        description:   'Auto-completed: wallet balance depleted (≤ 1)',
      });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // REVERSE A SETTLED-BET CONTRIBUTION
  //   Called when a bet is cancelled/refunded (e.g. Palace `cancel`).
  //   Undoes exactly what `contributeFromSettledBet` added: we look up
  //   the original CONTRIBUTION ledger rows for that bet and subtract
  //   each from its specific requirement (so a multi-req split unwinds
  //   correctly). A requirement that completed off this bet re-opens if
  //   it drops back below target. Requirements already ARCHIVED (e.g. a
  //   withdrawal reset zeroed them) or CANCELLED are skipped — their
  //   progress is already gone, so there is nothing to take back.
  //
  //   `betReferenceId`    = reference_id used on the original contribution
  //                         (the slot bet's transaction id).
  //   `cancelReferenceId` = id to stamp on the reversal ledger rows
  //                         (the cancel transaction id).
  // ═════════════════════════════════════════════════════════════
  async reverseContribution(
    qr: QueryRunner,
    userId: number,
    betReferenceId: number,
    cancelReferenceId: number,
  ): Promise<void> {
    // What did this bet contribute, per requirement? (One bet can hit several
    // reqs FIFO.) Idempotency is guaranteed by the caller — the Palace cancel
    // handler runs this once per original transaction via its is_cancelled flag.
    const contribs = await qr.query(
      `SELECT requirement_id, COALESCE(SUM(amount), 0) AS total
         FROM turnover_ledger
        WHERE user_id = $1
          AND reference_type = 'BET'
          AND reference_id = $2
          AND event_type = 'CONTRIBUTION'
        GROUP BY requirement_id`,
      [userId, betReferenceId],
    );
    if (!contribs.length) return;

    for (const c of contribs) {
      const reverseAmt = parseFloat(c.total);
      if (reverseAmt <= 0) continue;

      const reqs = await qr.query(
        `SELECT id, target_amount, current_amount, status, completed_at
           FROM turnover_requirements
          WHERE id = $1
          FOR UPDATE`,
        [c.requirement_id],
      );
      if (!reqs.length) continue;

      const req = reqs[0];
      // Only live progress can be taken back. ARCHIVED/CANCELLED are final.
      if (req.status !== 'ACTIVE' && req.status !== 'COMPLETED') continue;

      const current   = parseFloat(req.current_amount);
      const target    = parseFloat(req.target_amount);
      const newAmount = Math.max(0, current - reverseAmt);

      // If this bet had completed the requirement, dropping below target
      // re-opens it (ACTIVE, clear completed_at).
      let newStatus: string = req.status;
      let completedAt: Date | null = req.completed_at;
      if (req.status === 'COMPLETED' && newAmount < target) {
        newStatus   = 'ACTIVE';
        completedAt = null;
      }

      await qr.query(
        `UPDATE turnover_requirements
           SET current_amount = $1, status = $2, completed_at = $3, updated_at = NOW()
         WHERE id = $4`,
        [newAmount, newStatus, completedAt, req.id],
      );

      await this.turnoverLedger.write({
        qr,
        userId,
        requirementId: req.id,
        eventType:     'REVERSAL',
        amount:        reverseAmt,
        balanceBefore: current,
        balanceAfter:  newAmount,
        referenceType: 'BET',
        referenceId:   cancelReferenceId,
        description:   `Reversed ${reverseAmt} turnover — bet cancelled`,
      });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // GUARD: BLOCK WITHDRAWAL IF ANY ACTIVE REQS
  //   Called from wallet.requestWithdrawal() before locking funds.
  // ═════════════════════════════════════════════════════════════
  async ensureNoActiveReqs(qr: QueryRunner, userId: number): Promise<void> {
    const active = await qr.query(
      `SELECT id, target_amount, current_amount
       FROM turnover_requirements
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );

    if (active.length === 0) return;

    const totalRemaining = active.reduce((sum: number, r: any) => {
      return sum + (parseFloat(r.target_amount) - parseFloat(r.current_amount));
    }, 0);

    throw new ForbiddenException({
      message: 'Withdrawal blocked: turnover requirement incomplete',
      activeRequirements: active.length,
      remainingTurnover: Number(totalRemaining.toFixed(2)),
      hint: `Place ${totalRemaining.toFixed(2)} more in bets (and wait for settlement) to unlock withdrawal.`,
    });
  }

  // ═════════════════════════════════════════════════════════════
  // RESET ON WITHDRAWAL APPROVAL
  //   Per design: reset to ZERO on every approved withdrawal.
  //   Archives all ACTIVE and COMPLETED reqs (preserving history).
  // ═════════════════════════════════════════════════════════════
  async resetAllActive(
    qr: QueryRunner,
    userId: number,
    withdrawalId: number,
  ): Promise<{ resetCount: number }> {
    const reqs = await qr.query(
      `SELECT id, current_amount FROM turnover_requirements
       WHERE user_id = $1 AND status IN ('ACTIVE', 'COMPLETED')
       FOR UPDATE`,
      [userId],
    );

    if (reqs.length === 0) return { resetCount: 0 };

    for (const req of reqs) {
      const current = parseFloat(req.current_amount);

      await qr.query(
        `UPDATE turnover_requirements
         SET status = 'ARCHIVED', archived_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [req.id],
      );

      await this.turnoverLedger.write({
        qr,
        userId,
        requirementId: req.id,
        eventType:     'RESET',
        amount:        current,
        balanceBefore: current,
        balanceAfter:  0,
        referenceType: 'WITHDRAWAL',
        referenceId:   withdrawalId,
        description:   'Reset on withdrawal approval',
      });
    }

    return { resetCount: reqs.length };
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE: INSERT NEW REQUIREMENT  use by PromotionEngineService when applying a promotion.
  // ═════════════════════════════════════════════════════════════
   async insertRequirement(
    qr: QueryRunner,
    data: {
      userId: number;
      sourceType: 'DEPOSIT' | 'PROMOTION' | 'MANUAL' | 'BONUS';
      sourceId?: number | null;
      baseAmount: number;
      multiplier: number;
      targetAmount: number;
      adminId?: number;
      label?: string | null;
    },
  ): Promise<{ requirementId: number; targetAmount: number }> {
    // A new requirement supersedes finished ones on the wagering page: archive
    // the user's COMPLETED requirements so only the live one (plus any still
    // in-progress) remains visible. (Completed reqs also auto-hide after 7
    // days via the read queries.)
    await qr.query(
      `UPDATE turnover_requirements
       SET status = 'ARCHIVED', archived_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'COMPLETED'`,
      [data.userId],
    );

    const result = await qr.query(
      `INSERT INTO turnover_requirements
        (user_id, source_type, source_id, base_amount, multiplier,
         target_amount, current_amount, status, created_by_admin_id, label)
       VALUES ($1,$2,$3,$4,$5,$6,0,'ACTIVE',$7,$8)
       RETURNING id, target_amount`,
      [
        data.userId,
        data.sourceType,
        data.sourceId ?? null,
        data.baseAmount,
        data.multiplier,
        data.targetAmount,
        data.adminId ?? null,
        data.label ?? null,
      ],
    );

    return {
      requirementId: Number(result[0].id),
      targetAmount:  parseFloat(result[0].target_amount),
    };
  }

  // ═════════════════════════════════════════════════════════════
  // QUERIES (USER-FACING)
  // ═════════════════════════════════════════════════════════════
  // Aggregated headline numbers for the user's wagering page:
  //   requiredTurnover = Σ target_amount   (the bar's max)
  //   validTurnover    = Σ current_amount  (how far they've wagered)
  //   progressPercent  = valid / required
  // Aggregates ACTIVE requirements only (in-progress wagering). When there is
  // no active requirement, the user is free to withdraw → progress is 100%.
  async getMyTurnoverSummary(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(target_amount), 0)                        AS required,
         COALESCE(SUM(current_amount), 0)                       AS valid,
         COALESCE(SUM(target_amount - current_amount), 0)       AS remaining,
         COUNT(*)::int                                          AS active_count
       FROM turnover_requirements
       WHERE user_id = $1 AND status = 'ACTIVE'`,
      [userId],
    );

    const required  = parseFloat(rows[0].required);
    const valid     = parseFloat(rows[0].valid);
    const remaining = parseFloat(rows[0].remaining);
    const progressPercent =
      required > 0
        ? Number(Math.min((valid / required) * 100, 100).toFixed(2))
        : 100;

    const requirements = await this.getMyActiveRequirements(userId);

    return {
      requiredTurnover:    required,
      validTurnover:       valid,
      remainingTurnover:   remaining,
      progressPercent,
      activeRequirements:  rows[0].active_count,
      requirements,
    };
  }

  // Requirements shown on the wagering page: everything still ACTIVE (until
  // finished), plus COMPLETED ones for 7 days after completion (then they
  // drop off — also archived early when a new requirement is created).
  // `label` is the header (e.g. "Weekly Loss Bonus"); each row carries its
  // own progress so the UI can render an individual progress bar.
  async getMyActiveRequirements(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT id, source_type, source_id, label, base_amount, multiplier,
              target_amount, current_amount, status, completed_at,
              created_at,
              (target_amount - current_amount) AS remaining
       FROM turnover_requirements
       WHERE user_id = $1
         AND (
           status = 'ACTIVE'
           OR (status = 'COMPLETED' AND completed_at > NOW() - INTERVAL '7 days')
         )
       ORDER BY created_at DESC`,
      [userId],
    );

    return rows.map((r: any) => {
      const target  = parseFloat(r.target_amount);
      const current = parseFloat(r.current_amount);
      const remaining = parseFloat(r.remaining);
      return {
        id:            Number(r.id),
        label:         r.label ?? this.defaultLabelFor(r.source_type),
        sourceType:    r.source_type,
        sourceId:      r.source_id === null ? null : Number(r.source_id),
        baseAmount:    parseFloat(r.base_amount),
        multiplier:    parseFloat(r.multiplier),
        targetAmount:  target,
        currentAmount: current,
        remaining,
        // currentAmount stays at what the player actually wagered. A COMPLETED
        // requirement reads 100% (it IS done) even if it was force-completed
        // below target (wallet depleted / admin), so the bar isn't stuck < full.
        progressPercent:
          r.status === 'COMPLETED'
            ? 100
            : target > 0
              ? Number(Math.min((current / target) * 100, 100).toFixed(2))
              : 100,
        status:        r.status,
        completedAt:   r.completed_at,
        createdAt:     r.created_at,
      };
    });
  }

  // Fallback header when a requirement has no explicit label (e.g. older
  // promotion/deposit rows created before labels existed).
  private defaultLabelFor(sourceType: string): string {
    switch (sourceType) {
      case 'DEPOSIT':   return 'Deposit turnover';
      case 'PROMOTION': return 'Promotion turnover';
      case 'BONUS':     return 'Bonus turnover';
      case 'MANUAL':    return 'Bonus turnover';
      default:          return 'Turnover requirement';
    }
  }

  async getMyTurnoverHistory(userId: number, page = 1, limit = 50) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const offset = (Math.max(page, 1) - 1) * safeLimit;

    const rows = await this.dataSource.query(
      `SELECT tl.id, tl.requirement_id, tl.event_type, tl.amount,
              tl.balance_before, tl.balance_after,
              tl.reference_type, tl.reference_id,
              tl.description, tl.created_at,
              tr.source_type
       FROM turnover_ledger tl
       JOIN turnover_requirements tr ON tr.id = tl.requirement_id
       WHERE tl.user_id = $1
       ORDER BY tl.created_at DESC, tl.id DESC
       LIMIT $2 OFFSET $3`,
      [userId, safeLimit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM turnover_ledger WHERE user_id = $1`,
      [userId],
    );

    return { data: rows, page, limit: safeLimit, total: count[0].total };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST USER REQUIREMENTS
  // ═════════════════════════════════════════════════════════════
  async adminListUserRequirements(userId: number, status?: string) {
    const params: any[] = [userId];
    let where = `user_id = $1`;
    if (status) {
      params.push(status);
      where += ` AND status = $2`;
    }

    return this.dataSource.query(
      `SELECT * FROM turnover_requirements
       WHERE ${where}
       ORDER BY created_at DESC`,
      params,
    );
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: ADJUST PROGRESS (compensation, fraud reversal)
  // ═════════════════════════════════════════════════════════════
  async adminAdjustProgress(dto: AdminAdjustTurnoverDto, adminId: number) {
    if (dto.amount === 0) {
      throw new BadRequestException('amount cannot be zero');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const reqs = await qr.query(
        `SELECT * FROM turnover_requirements WHERE id = $1 FOR UPDATE`,
        [dto.requirementId],
      );
      if (!reqs.length) throw new NotFoundException('Requirement not found');

      const req = reqs[0];
      if (req.status !== 'ACTIVE' && req.status !== 'COMPLETED') {
        throw new BadRequestException(
          `Cannot adjust ${req.status} requirement`,
        );
      }

      const current   = parseFloat(req.current_amount);
      const target    = parseFloat(req.target_amount);
      const newAmount = Math.max(0, current + dto.amount);
      const willComplete = newAmount >= target;
      const wasComplete  = req.status === 'COMPLETED';

      let newStatus = req.status;
      let completedAt: Date | null = req.completed_at;

      if (willComplete && !wasComplete) {
        newStatus   = 'COMPLETED';
        completedAt = new Date();
      } else if (!willComplete && wasComplete) {
        newStatus   = 'ACTIVE';
        completedAt = null;
      }

      await qr.query(
        `UPDATE turnover_requirements
         SET current_amount = $1, status = $2, completed_at = $3, updated_at = NOW()
         WHERE id = $4`,
        [newAmount, newStatus, completedAt, dto.requirementId],
      );

      await this.turnoverLedger.write({
        qr,
        userId:        req.user_id,
        requirementId: req.id,
        eventType:     'ADMIN_ADJUST',
        amount:        Math.abs(dto.amount),
        balanceBefore: current,
        balanceAfter:  newAmount,
        referenceType: 'ADMIN',
        referenceId:   adminId,
        description:   `Admin ${dto.amount > 0 ? 'added' : 'removed'} ${Math.abs(dto.amount)}: ${dto.reason}`,
      });

      await qr.commitTransaction();
      return {
        message: 'Turnover progress adjusted',
        requirementId: req.id,
        before: current,
        after:  newAmount,
        status: newStatus,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CANCEL REQUIREMENT
  // ═════════════════════════════════════════════════════════════
  async adminCancel(dto: AdminCancelTurnoverDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const reqs = await qr.query(
        `SELECT * FROM turnover_requirements WHERE id = $1 FOR UPDATE`,
        [dto.requirementId],
      );
      if (!reqs.length) throw new NotFoundException('Requirement not found');

      const req = reqs[0];
      if (req.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Only ACTIVE requirements can be cancelled (this is ${req.status})`,
        );
      }

      const current = parseFloat(req.current_amount);

      await qr.query(
        `UPDATE turnover_requirements
         SET status = 'CANCELLED', updated_at = NOW()
         WHERE id = $1`,
        [dto.requirementId],
      );

      await this.turnoverLedger.write({
        qr,
        userId:        req.user_id,
        requirementId: req.id,
        eventType:     'CANCELLED',
        amount:        current,
        balanceBefore: current,
        balanceAfter:  current,
        referenceType: 'ADMIN',
        referenceId:   adminId,
        description:   `Cancelled by admin: ${dto.reason}`,
      });

      await qr.commitTransaction();
      return { message: 'Requirement cancelled' };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE MANUAL REQUIREMENT
  // ═════════════════════════════════════════════════════════════
  async adminCreateManual(dto: AdminCreateTurnoverDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const multiplier   = dto.multiplier ?? 1.0;
      const targetAmount = dto.baseAmount * multiplier;

      const result = await this.insertRequirement(qr, {
        userId:       dto.userId,
        sourceType:   dto.sourceType ?? 'MANUAL',
        sourceId:     null,
        baseAmount:   dto.baseAmount,
        multiplier,
        targetAmount,
        adminId,
      });

      await this.turnoverLedger.write({
        qr,
        userId:        dto.userId,
        requirementId: result.requirementId,
        eventType:     'ADMIN_ADJUST',
        amount:        0,
        balanceBefore: 0,
        balanceAfter:  0,
        referenceType: 'ADMIN',
        referenceId:   adminId,
        description:   `Manual requirement created: ${dto.reason}`,
      });

      await qr.commitTransaction();
      return { message: 'Manual requirement created', ...result };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST ALL TURNOVER REQUIREMENTS (management table)
  //   Promotion name + code, completed / remaining / target, created /
  //   completed_at, who created it (approved_by), and per-row progress.
  // ═════════════════════════════════════════════════════════════
  async adminListRequirements(q: {
    status?: string;
    search?: string;
    userId?: number;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.status && q.status.toUpperCase() !== 'ALL') {
      where.push(`tr.status = $${i++}`);
      params.push(q.status.toUpperCase());
    }
    if (q.userId !== undefined) {
      where.push(`tr.user_id = $${i++}`);
      params.push(q.userId);
    }
    if (q.search) {
      where.push(
        `(p.code ILIKE $${i} OR p.title ILIKE $${i} OR tr.label ILIKE $${i} OR u.username ILIKE $${i})`,
      );
      params.push(`%${q.search}%`);
      i++;
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.dataSource.query(
      `SELECT
         tr.id,
         tr.user_id,
         u.username,
         u.full_name,
         tr.source_type,
         tr.source_id,
         COALESCE(tr.label, p.title)                     AS promotion_name,
         p.code                                          AS promo_code,
         tr.base_amount,
         tr.multiplier,
         tr.target_amount,
         tr.current_amount                               AS completed,
         (tr.target_amount - tr.current_amount)          AS remaining,
         CASE WHEN tr.target_amount > 0
              THEN LEAST(ROUND((tr.current_amount / tr.target_amount) * 100, 2), 100)
              ELSE 100 END                               AS progress_percent,
         tr.status,
         tr.created_at,
         tr.completed_at,
         tr.created_by_admin_id,
         au.name                                         AS approved_by
       FROM turnover_requirements tr
       JOIN users u            ON u.id = tr.user_id
       -- Only PROMOTION rows reference a promotion via source_id. Referral
       -- ("Buddy Bonus", source_type BONUS) stores source_id = referral id, so
       -- it must NOT join here or it would pick up an unrelated promo's code.
       -- Its name still resolves via COALESCE(tr.label, …) below.
       LEFT JOIN promotions p  ON p.id = tr.source_id
                               AND tr.source_type = 'PROMOTION'
       LEFT JOIN admin_users au ON au.id = tr.created_by_admin_id
       ${whereSql}
       ORDER BY tr.created_at DESC, tr.id DESC
       LIMIT $${i++} OFFSET $${i++}`,
      [...params, limit, offset],
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total
       FROM turnover_requirements tr
       JOIN users u           ON u.id = tr.user_id
       LEFT JOIN promotions p ON p.id = tr.source_id
                              AND tr.source_type = 'PROMOTION'
       ${whereSql}`,
      params,
    );

    return {
      data: rows.map((r: any) => ({
        id: Number(r.id),
        userId: Number(r.user_id),
        username: r.username,
        fullName: r.full_name,
        sourceType: r.source_type,
        sourceId: r.source_id === null ? null : Number(r.source_id),
        promotionName: r.promotion_name,
        promoCode: r.promo_code,
        // The actual deposit/bonus amount the requirement was created from;
        // target = actualAmount × multiplier.
        actualAmount: Number(r.base_amount),
        multiplier: Number(r.multiplier),
        target: Number(r.target_amount),
        completed: Number(r.completed),
        remaining: Number(r.remaining),
        progressPercent: Number(r.progress_percent),
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        approvedBy: r.approved_by,
      })),
      page,
      limit,
      total: cnt?.total ?? 0,
      totalPages: Math.ceil((cnt?.total ?? 0) / limit) || 0,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: FORCE-COMPLETE A TURNOVER REQUIREMENT ("Turnover Complete")
  //   Sets current = target and marks COMPLETED. Idempotent-safe: only
  //   ACTIVE requirements can be completed.
  // ═════════════════════════════════════════════════════════════
  async adminCompleteTurnover(requirementId: number, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const reqs = await qr.query(
        `SELECT * FROM turnover_requirements WHERE id = $1 FOR UPDATE`,
        [requirementId],
      );
      if (!reqs.length) throw new NotFoundException('Requirement not found');

      const req = reqs[0];
      if (req.status !== 'ACTIVE') {
        throw new BadRequestException(
          `Only ACTIVE requirements can be completed (this is ${req.status})`,
        );
      }

      const current = parseFloat(req.current_amount);

      // Flip to COMPLETED but keep current_amount = what the player actually
      // wagered (don't inflate to target), so the displayed completed amount
      // reflects reality.
      await qr.query(
        `UPDATE turnover_requirements
         SET status = 'COMPLETED',
             completed_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [requirementId],
      );

      await this.turnoverLedger.write({
        qr,
        userId:        req.user_id,
        requirementId: req.id,
        eventType:     'COMPLETED',
        amount:        0, // administrative completion — no real turnover added
        balanceBefore: current,
        balanceAfter:  current,
        referenceType: 'ADMIN',
        referenceId:   adminId,
        description:   'Turnover marked complete by admin',
      });

      await qr.commitTransaction();
      return {
        message: 'Turnover marked complete',
        requirementId: req.id,
        completed: current,
        status: 'COMPLETED',
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
}