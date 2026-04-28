// src/turnover/turnover.service.ts
import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { TurnoverLedgerService } from '../ledger/turnover-ledger.service';
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
  ) {}

  // ═════════════════════════════════════════════════════════════
  // CREATE FROM DEPOSIT
  //   Called from wallet.decideDeposit() on APPROVE.
  //   Skips entirely if no promotion attached.
  // ═════════════════════════════════════════════════════════════
  async createFromDeposit(
    qr: QueryRunner,
    userId: number,
    depositId: number,
    depositAmount: number,
    promotionId: number | null,
  ): Promise<{ requirementId: number; targetAmount: number } | null> {
    if (!promotionId) return null;

    const promo = await qr.query(
      `SELECT id, rollover_multiplier, bonus_amount, bonus_percentage,
              min_deposit, is_active
       FROM promotions WHERE id = $1`,
      [promotionId],
    );
    if (!promo.length) return null;

    const p = promo[0];
    if (!p.is_active) return null;

    const multiplier = parseFloat(p.rollover_multiplier ?? '0');
    if (!multiplier || multiplier <= 0) return null;

    let bonus = 0;
    if (p.bonus_amount) {
      bonus = parseFloat(p.bonus_amount);
    } else if (p.bonus_percentage) {
      bonus = depositAmount * (parseFloat(p.bonus_percentage) / 100);
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
    },
  ): Promise<{ requirementId: number; targetAmount: number }> {
    const result = await qr.query(
      `INSERT INTO turnover_requirements
        (user_id, source_type, source_id, base_amount, multiplier,
         target_amount, current_amount, status, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,0,'ACTIVE',$7)
       RETURNING id, target_amount`,
      [
        data.userId,
        data.sourceType,
        data.sourceId ?? null,
        data.baseAmount,
        data.multiplier,
        data.targetAmount,
        data.adminId ?? null,
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
  async getMyActiveRequirements(userId: number) {
    return this.dataSource.query(
      `SELECT id, source_type, source_id, base_amount, multiplier,
              target_amount, current_amount, status, completed_at,
              created_at,
              (target_amount - current_amount) AS remaining
       FROM turnover_requirements
       WHERE user_id = $1 AND status IN ('ACTIVE', 'COMPLETED')
       ORDER BY created_at DESC`,
      [userId],
    );
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
}