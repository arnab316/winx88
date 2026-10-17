import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { PromotionEngineService } from 'src/promotion/promotion-engine.service';
import { TurnoverService } from 'src/turnover/turnover.service';

/**
 * Promotions, bonuses and wagering progress.
 *
 * Eligibility is NOT decided here. `PromotionEngineService.validateForUser`
 * is the only thing in the platform that may say yes or no to a promotion,
 * and this service asks it and relays the answer — including its refusal
 * message, which is already written to be read by a customer.
 *
 * Wagering progress likewise comes from TurnoverService. A support agent
 * quoting a different "you need to wager X more" than the player's own screen
 * is the specific failure this avoids.
 */
@Injectable()
export class AiSupportPromotionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly promotions: PromotionEngineService,
    private readonly turnover: TurnoverService,
  ) {}

  /** Promotions this customer can see and claim right now. */
  async listActive(userId: number) {
    const res: any = await this.promotions.listAvailableForUser(userId);
    const list = res?.data ?? res ?? [];
    return {
      customerId: userId,
      total: Array.isArray(list) ? list.length : 0,
      data: (Array.isArray(list) ? list : []).map((p: any) => this.shape(p)),
    };
  }

  async getPromotion(userId: number, promotionId: number) {
    const [p] = await this.dataSource.query(
      `SELECT id, title, code, description, kind, bonus_type, bonus_value,
              min_amount, max_bonus, rollover_multiplier, currency,
              starts_at, ends_at, is_active
         FROM promotions WHERE id = $1 LIMIT 1`,
      [promotionId],
    );
    if (!p) throw new NotFoundException('Promotion not found');
    return this.shape(p);
  }

  /**
   * Why a customer can or cannot claim a promotion.
   *
   * The engine throws a customer-readable message when it refuses, so the
   * refusal IS the answer — there is no second rulebook here that could drift
   * away from the one that actually gates the claim.
   */
  async checkEligibility(
    userId: number,
    promotionId: number,
    depositAmount?: number,
  ) {
    try {
      const res: any = await this.promotions.validateForUser(
        null,
        userId,
        promotionId,
        depositAmount != null ? { depositAmount } : {},
      );
      return {
        customerId: userId,
        promotionId,
        eligible: true,
        reason: null,
        estimatedBonus: res?.estimatedBonus ?? null,
        promotion: res?.promotion ? this.shape(res.promotion) : null,
      };
    } catch (e: any) {
      // A refusal is a normal answer here, not a server error.
      return {
        customerId: userId,
        promotionId,
        eligible: false,
        reason: e?.message ?? 'This promotion is not available for this account.',
        estimatedBonus: null,
        promotion: null,
      };
    }
  }

  /** Bonus claims: active, completed, cancelled and forfeited. */
  async listBonuses(userId: number, page = 1, limit = 20) {
    const res: any = await this.promotions.getMyClaims(userId, page, limit);
    const list = res?.data ?? res?.items ?? res ?? [];
    return {
      customerId: userId,
      ...(res?.total != null ? { total: res.total, page, limit } : {}),
      data: (Array.isArray(list) ? list : []).map((c: any) => this.shapeClaim(c)),
    };
  }

  async getBonus(userId: number, bonusId: number) {
    const [c] = await this.dataSource.query(
      `SELECT c.id, c.promotion_id, c.bonus_amount, c.rollover_target,
              c.turnover_requirement_id, c.status, c.claimed_at,
              c.completed_at, c.cancelled_at, c.cancellation_reason,
              p.title AS promotion_title, p.code AS promotion_code
         FROM user_promotion_claims c
         LEFT JOIN promotions p ON p.id = c.promotion_id
        WHERE c.id = $1 AND c.user_id = $2
        LIMIT 1`,
      [bonusId, userId],
    );
    if (!c) throw new NotFoundException('Bonus not found');
    return this.shapeClaim(c);
  }

  /**
   * Wagering progress for one bonus.
   *
   * Reads the turnover requirement the claim points at, so the percentage
   * matches the player's own wagering screen to the decimal.
   */
  async getBonusProgress(userId: number, bonusId: number) {
    const [c] = await this.dataSource.query(
      `SELECT id, promotion_id, bonus_amount, turnover_requirement_id, status
         FROM user_promotion_claims
        WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [bonusId, userId],
    );
    if (!c) throw new NotFoundException('Bonus not found');

    if (!c.turnover_requirement_id) {
      return {
        bonusId: Number(c.id),
        hasWageringRequirement: false,
        message:
          'This bonus carries no wagering requirement, or one was never created for it.',
      };
    }

    // Scoped by user_id as well as id: the claim already belongs to this
    // customer, and the requirement must too.
    const [r] = await this.dataSource.query(
      `SELECT id, label, base_amount, multiplier, target_amount,
              current_amount, status, completed_at, created_at
         FROM turnover_requirements
        WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [c.turnover_requirement_id, userId],
    );
    if (!r) {
      return {
        bonusId: Number(c.id),
        hasWageringRequirement: false,
        message:
          'The wagering requirement linked to this bonus no longer exists. Support can review it.',
      };
    }

    const target = Number(r.target_amount);
    const current = Number(r.current_amount);
    const remaining = Math.max(0, Number((target - current).toFixed(2)));

    return {
      bonusId: Number(c.id),
      hasWageringRequirement: true,
      requirementId: Number(r.id),
      label: r.label ?? null,
      status: r.status,
      multiplier: Number(r.multiplier),
      baseAmount: Number(r.base_amount),
      targetAmount: target,
      wageredAmount: current,
      remainingAmount: remaining,
      progressPercent:
        target > 0 ? Number(((current / target) * 100).toFixed(2)) : 100,
      completedAt: r.completed_at ?? null,
      startedAt: r.created_at,
      customerMessage:
        r.status === 'COMPLETED'
          ? 'This wagering requirement is complete.'
          : `${remaining} more needs to be wagered before this bonus unlocks.`,
    };
  }

  /** Every active wagering requirement, not just those tied to a bonus. */
  async getWageringOverview(userId: number) {
    const [summary, active] = await Promise.all([
      this.turnover.getMyTurnoverSummary(userId).catch(() => null),
      this.turnover.getMyActiveRequirements(userId).catch(() => null),
    ]);
    return { customerId: userId, summary, activeRequirements: active };
  }

  private shape(p: any) {
    return {
      promotionId: Number(p.id),
      title: p.title,
      code: p.code ?? null,
      description: p.description ?? null,
      kind: p.kind ?? null,
      bonusType: p.bonus_type ?? p.bonusType ?? null,
      bonusValue: p.bonus_value != null ? Number(p.bonus_value) : null,
      minDeposit: p.min_amount != null ? Number(p.min_amount) : null,
      maxBonus: p.max_bonus != null ? Number(p.max_bonus) : null,
      wageringMultiplier:
        p.rollover_multiplier != null ? Number(p.rollover_multiplier) : null,
      currency: p.currency ?? null,
      startsAt: p.starts_at ?? null,
      endsAt: p.ends_at ?? null,
      isActive: p.is_active ?? null,
    };
  }

  private shapeClaim(c: any) {
    const status = String(c.status ?? '').toUpperCase();
    return {
      bonusId: Number(c.id),
      promotionId: c.promotion_id != null ? Number(c.promotion_id) : null,
      promotionTitle: c.promotion_title ?? c.title ?? null,
      promotionCode: c.promotion_code ?? null,
      bonusAmount: c.bonus_amount != null ? Number(c.bonus_amount) : 0,
      wageringTarget:
        c.rollover_target != null ? Number(c.rollover_target) : null,
      status,
      claimedAt: c.claimed_at ?? null,
      completedAt: c.completed_at ?? null,
      cancelledAt: c.cancelled_at ?? null,
      // Recorded by an admin or by the customer's own cancellation.
      cancellationReason: c.cancellation_reason ?? null,
      hasWageringRequirement: c.turnover_requirement_id != null,
    };
  }
}
