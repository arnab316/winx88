import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

import { DataSource, QueryRunner } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { TurnoverService } from '../turnover/turnover.service';
import { MemberGroupService } from '../member-group/member-group.service';
import {
  CreatePromotionDto,
  UpdatePromotionDto,
  ListPromotionsQueryDto,
  GrantManualBonusDto,
  CancelClaimDto,
  PromotionKind,
  BonusDestination,
} from './dto/promotion.dto';
 

export interface BonusComputation {
  bonusAmount: number;
  rolloverTarget: number;
  cappedByMaxBonus: boolean;
  cappedByPool: boolean;
}

export interface ApplyResult {
  claimId: number;
  bonusAmount: number;
  bonusDestination: BonusDestination;
  turnoverRequirementId: number | null;
  rolloverTarget: number;
}
@Injectable()
export class PromotionEngineService  {

      constructor(
          private dataSource: DataSource,
    private financialLedger: FinancialLedgerService,
    private turnoverService: TurnoverService,
    private memberGroupService: MemberGroupService,
      ) {}

       // ═════════════════════════════════════════════════════════════
  // PUBLIC API: validate eligibility (read-only check)
  //   Throws if not eligible. Returns nothing if OK.
  //
  //   Used by:
  //     - wallet.requestDeposit() before accepting a promo selection
  //     - claimByCode() before applying
  // ═════════════════════════════════════════════════════════════
  async validateForUser(
    qr: QueryRunner | null,
    userId: number,
    promotionId: number,
    context: { kind?: PromotionKind; depositAmount?: number },
  ): Promise<{ promotion: any; estimatedBonus: BonusComputation }> {
    const runner = qr ?? this.dataSource;
 
    // 1. Load + lock the promotion (caller's qr if in transaction)
    const lockClause = qr ? ' FOR UPDATE' : '';
    const rows = await runner.query(
      `SELECT * FROM promotions WHERE id = $1${lockClause}`,
      [promotionId],
    );
    if (!rows.length) throw new NotFoundException('Promotion not found');
    const p = rows[0];
 
    // 2. Active flag
    if (!p.is_active) {
      throw new BadRequestException('Promotion is not active');
    }
 
    // 3. Date window
    const now = new Date();
    if (p.starts_at && new Date(p.starts_at) > now) {
      throw new BadRequestException('Promotion has not started yet');
    }
    if (p.ends_at && new Date(p.ends_at) < now) {
      throw new BadRequestException('Promotion has expired');
    }
 
    // 4. Kind match (if caller specified)
    if (context.kind && p.kind !== context.kind) {
      throw new BadRequestException(
        `Promotion is of kind ${p.kind}, not ${context.kind}`,
      );
    }
 
    // 5. Member group eligibility
    const inGroup = await this.memberGroupService.isUserInGroup(
      qr,
      userId,
      p.member_group_id,
    );
    if (!inGroup) {
      throw new ForbiddenException('You are not eligible for this promotion');
    }
 
    // 6. Per-user use limit
    const usesByUser = await runner.query(
      `SELECT COUNT(*)::int AS c FROM user_promotion_claims
       WHERE user_id = $1 AND promotion_id = $2
         AND status IN ('PENDING','ACTIVE','COMPLETED')`,
      [userId, promotionId],
    );
    if (usesByUser[0].c >= Number(p.max_uses_per_user)) {
      throw new BadRequestException(
        `You have already claimed this promotion ${usesByUser[0].c} time(s)`,
      );
    }
 
    // 7. Global use limit
    if (p.max_uses_global && Number(p.uses_count) >= Number(p.max_uses_global)) {
      throw new BadRequestException('Promotion claim limit reached');
    }
 
    // 8. Bonus pool exhausted
    if (p.max_bonus_pool && Number(p.bonus_paid_total) >= Number(p.max_bonus_pool)) {
      throw new BadRequestException('Promotion bonus pool exhausted');
    }
 
    // 9. Min deposit (only relevant for DEPOSIT kind)
    if (p.kind === 'DEPOSIT') {
      if (context.depositAmount === undefined || context.depositAmount === null) {
        throw new BadRequestException(
          'depositAmount required to validate DEPOSIT promotion',
        );
      }
      if (p.min_amount && context.depositAmount < parseFloat(p.min_amount)) {
        throw new BadRequestException(
          `Minimum deposit for this promo is ${p.min_amount}`,
        );
      }
    }
 
    // 10. Estimate bonus (also catches "calculation produces zero" edge cases)
    const computation = this.computeBonus(p, context.depositAmount ?? 0);
    if (computation.bonusAmount <= 0) {
      throw new BadRequestException(
        'This promotion would result in no bonus (check minimum deposit / promo formula)',
      );
    }
 
    return { promotion: p, estimatedBonus: computation };
  }
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC API: apply (mutates state)
  //   This is THE method called from wallet.decideDeposit's APPROVE
  //   branch when a promotion_id is attached.
  //
  //   Atomic: bonus credit + claim row + turnover req + ledger.
  // ═════════════════════════════════════════════════════════════
  async apply(
    qr: QueryRunner,
    userId: number,
    promotionId: number,
    context: {
      kind?: PromotionKind;
      depositId?: number | null;
      depositAmount?: number;
      adminId?: number;
    },
  ): Promise<ApplyResult> {
    // 1. Re-validate inside the transaction (catches races between
    //    request-time validation and approval-time apply)
    const { promotion, estimatedBonus } = await this.validateForUser(
      qr,
      userId,
      promotionId,
      { kind: context.kind, depositAmount: context.depositAmount },
    );
 
    const bonusAmount = estimatedBonus.bonusAmount;
    const bonusDest: BonusDestination = promotion.bonus_to;
 
    // 2. Credit the user's wallet
    await this.creditWallet(qr, userId, bonusAmount, bonusDest, {
      promotionId: promotion.id,
      depositId: context.depositId ?? null,
      adminId: context.adminId,
    });
 
    // 3. Create turnover requirement (if rollover > 0)
    let turnoverReqId: number | null = null;
    let rolloverTarget = 0;
    const rolloverMult = parseFloat(promotion.rollover_multiplier);
 
    if (rolloverMult > 0) {
      // Base for rollover = bonus + deposit (if there was a deposit)
      const base = bonusAmount + (context.depositAmount ?? 0);
      const target = base * rolloverMult;
 
      const reqResult = await this.turnoverService['insertRequirement'](qr, {
        userId,
        sourceType: context.kind === 'REGISTRATION' ? 'BONUS' : 'PROMOTION',
        sourceId: promotion.id,
        baseAmount: base,
        multiplier: rolloverMult,
        targetAmount: target,
        adminId: context.adminId,
      } as any);
 
      turnoverReqId = reqResult.requirementId;
      rolloverTarget = reqResult.targetAmount;
    }
 
    // 4. Insert claim row
    const claimResult = await qr.query(
      `INSERT INTO user_promotion_claims
        (user_id, promotion_id, deposit_id, bonus_amount,
         rollover_target, turnover_requirement_id, status, meta)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7)
       RETURNING id`,
      [
        userId,
        promotion.id,
        context.depositId ?? null,
        bonusAmount,
        rolloverTarget,
        turnoverReqId,
        JSON.stringify({
          kind: context.kind,
          appliedAt: new Date().toISOString(),
          bonusType: promotion.bonus_type,
          bonusValue: parseFloat(promotion.bonus_value),
        }),
      ],
    );
    const claimId = Number(claimResult[0].id);
 
    // 5. Bump promotion counters + auto-disable if pool exhausted
    await this.bumpCountersAndMaybeDisable(qr, promotion, bonusAmount);
 
    return {
      claimId,
      bonusAmount,
      bonusDestination: bonusDest,
      turnoverRequirementId: turnoverReqId,
      rolloverTarget,
    };
  }
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC API: claim by promo code (no deposit attached)
  //   For PROMOCODE kind only. Issues bonus immediately.
  // ═════════════════════════════════════════════════════════════
  async claimByCode(userId: number, code: string): Promise<ApplyResult> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
 
    try {
      // Find the promo by code
      const rows = await qr.query(
        `SELECT id FROM promotions WHERE code = $1 AND kind = 'PROMOCODE' LIMIT 1`,
        [code.toUpperCase().trim()],
      );
      if (!rows.length) throw new NotFoundException('Invalid promo code');
 
      const result = await this.apply(qr, userId, rows[0].id, {
        kind: 'PROMOCODE',
        depositAmount: 0,
      });
 
      await qr.commitTransaction();
      return result;
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC API: signup bonus (called from auth on registration)
  //   Finds the active REGISTRATION promo (if any) and applies it.
  //   Silently no-ops if none configured — registration shouldn't fail
  //   just because no signup bonus is set up.
  // ═════════════════════════════════════════════════════════════
  async tryAwardSignupBonus(qr: QueryRunner, userId: number): Promise<ApplyResult | null> {
    const rows = await qr.query(
      `SELECT id FROM promotions
       WHERE kind = 'REGISTRATION' AND is_active = TRUE
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (ends_at IS NULL OR ends_at > NOW())
       ORDER BY id ASC
       LIMIT 1`,
    );
    if (!rows.length) return null;
 
    try {
      return await this.apply(qr, userId, rows[0].id, {
        kind: 'REGISTRATION',
        depositAmount: 0,
      });
    } catch {
      // Don't break registration just because signup bonus failed
      // (e.g. user matches no member group). Log silently.
      return null;
    }
  }
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC API: admin manual bonus
  // ═════════════════════════════════════════════════════════════
  async grantManualBonus(dto: GrantManualBonusDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
 
    try {
      // Verify user
      const u = await qr.query(`SELECT id FROM users WHERE id = $1`, [dto.userId]);
      if (!u.length) throw new NotFoundException('User not found');
 
      const bonusDest = dto.bonusTo ?? 'BONUS_BALANCE';
      const rolloverMult = dto.rolloverMultiplier ?? 0;
 
      // 1. Credit
      await this.creditWallet(qr, dto.userId, dto.amount, bonusDest, {
        adminId,
        promotionId: null,
        depositId: null,
      });
 
      // 2. Create turnover req if rollover specified
      let turnoverReqId: number | null = null;
      let rolloverTarget = 0;
      if (rolloverMult > 0) {
        const reqResult = await this.turnoverService['insertRequirement'](qr, {
          userId: dto.userId,
          sourceType: 'MANUAL',
          sourceId: null,
          baseAmount: dto.amount,
          multiplier: rolloverMult,
          targetAmount: dto.amount * rolloverMult,
          adminId,
        } as any);
        turnoverReqId = reqResult.requirementId;
        rolloverTarget = reqResult.targetAmount;
      }
 
      // 3. Find or create the "MANUAL" sentinel promotion to attach the claim to
      //    (lets us track admin-granted bonuses in the same claim history)
      const manual = await this.getOrCreateManualSentinel(qr, adminId);
 
      const claimResult = await qr.query(
        `INSERT INTO user_promotion_claims
          (user_id, promotion_id, bonus_amount, rollover_target,
           turnover_requirement_id, status, meta)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
         RETURNING id`,
        [
          dto.userId,
          manual.id,
          dto.amount,
          rolloverTarget,
          turnoverReqId,
          JSON.stringify({ kind: 'MANUAL', reason: dto.reason, adminId }),
        ],
      );
 
      await qr.commitTransaction();
      return {
        message: 'Manual bonus granted',
        claimId: Number(claimResult[0].id),
        bonusAmount: dto.amount,
        bonusDestination: bonusDest,
        turnoverRequirementId: turnoverReqId,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
 
  // ═════════════════════════════════════════════════════════════
  // PRIVATE: bonus calculation
  // ═════════════════════════════════════════════════════════════
  private computeBonus(promotion: any, depositAmount: number): BonusComputation {
    const bonusType = promotion.bonus_type as 'PERCENT' | 'FLAT';
    const bonusValue = parseFloat(promotion.bonus_value);
    const maxBonus = promotion.max_bonus ? parseFloat(promotion.max_bonus) : null;
    const maxPool = promotion.max_bonus_pool ? parseFloat(promotion.max_bonus_pool) : null;
    const paidSoFar = parseFloat(promotion.bonus_paid_total ?? '0');
    const rolloverMult = parseFloat(promotion.rollover_multiplier ?? '0');
 
    let bonusAmount: number;
    if (bonusType === 'PERCENT') {
      bonusAmount = depositAmount * (bonusValue / 100);
    } else {
      bonusAmount = bonusValue;
    }
 
    // Floor to 2 decimals
    bonusAmount = Math.floor(bonusAmount * 100) / 100;
 
    // Per-claim cap
    let cappedByMaxBonus = false;
    if (maxBonus && bonusAmount > maxBonus) {
      bonusAmount = maxBonus;
      cappedByMaxBonus = true;
    }
 
    // Pool cap (if granting this bonus would exceed pool, clamp to remaining)
    let cappedByPool = false;
    if (maxPool) {
      const remaining = maxPool - paidSoFar;
      if (remaining <= 0) {
        bonusAmount = 0;
      } else if (bonusAmount > remaining) {
        bonusAmount = remaining;
        cappedByPool = true;
      }
    }
 
    const rolloverTarget =
      rolloverMult > 0 ? (bonusAmount + depositAmount) * rolloverMult : 0;
 
    return { bonusAmount, rolloverTarget, cappedByMaxBonus, cappedByPool };
  }
 
  // ═════════════════════════════════════════════════════════════
  // PRIVATE: credit user wallet (BONUS_BALANCE or MAIN_BALANCE)
  // ═════════════════════════════════════════════════════════════
  private async creditWallet(
    qr: QueryRunner,
    userId: number,
    amount: number,
    destination: BonusDestination,
    refs: { promotionId: number | null; depositId: number | null; adminId?: number },
  ): Promise<void> {
    // Lock wallet
    const wRows = await qr.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!wRows.length) throw new NotFoundException('Wallet not found');
    const w = wRows[0];
 
    const balBefore = parseFloat(w.balance);
    const bonBefore = parseFloat(w.bonus_balance);
    const lckBefore = parseFloat(w.locked_balance);
 
    let balAfter = balBefore;
    let bonAfter = bonBefore;
 
    if (destination === 'BONUS_BALANCE') {
      bonAfter = bonBefore + amount;
      await qr.query(
        `UPDATE wallets SET bonus_balance = $1, updated_at = NOW() WHERE id = $2`,
        [bonAfter, w.id],
      );
    } else {
      balAfter = balBefore + amount;
      await qr.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
        [balAfter, w.id],
      );
    }
 
    await this.financialLedger.write({
      qr,
      walletId:      w.id,
      userId,
      entryType:     'PROMOTION_BONUS',
      flow:          'CREDIT',
      amount,
      balanceBefore: balBefore,
      balanceAfter:  balAfter,
      bonusBefore:   bonBefore,
      bonusAfter:    bonAfter,
      lockedBefore:  lckBefore,
      lockedAfter:   lckBefore,
      referenceType: refs.promotionId ? 'PROMOTION' : 'MANUAL_BONUS',
      referenceId:   refs.promotionId ?? refs.depositId ?? 0,
      status:        'SUCCESS',
      description:
        destination === 'BONUS_BALANCE'
          ? `Promotion bonus credited to bonus_balance`
          : `Promotion bonus credited to balance`,
      meta:          { destination, ...refs },
      createdByType: refs.adminId ? 'ADMIN' : 'SYSTEM',
      createdById:   refs.adminId,
    });
  }
 
  // ═════════════════════════════════════════════════════════════
  // PRIVATE: bump counters; auto-disable if pool/uses exhausted
  // ═════════════════════════════════════════════════════════════
  private async bumpCountersAndMaybeDisable(
    qr: QueryRunner,
    promotion: any,
    bonusGranted: number,
  ) {
    const newUsesCount = Number(promotion.uses_count) + 1;
    const newPaidTotal = parseFloat(promotion.bonus_paid_total) + bonusGranted;
 
    let shouldDeactivate = false;
    if (promotion.max_uses_global && newUsesCount >= Number(promotion.max_uses_global)) {
      shouldDeactivate = true;
    }
    if (promotion.max_bonus_pool && newPaidTotal >= parseFloat(promotion.max_bonus_pool)) {
      shouldDeactivate = true;
    }
 
    await qr.query(
      `UPDATE promotions
       SET uses_count = $1,
           bonus_paid_total = $2,
           is_active = CASE WHEN $3::boolean THEN FALSE ELSE is_active END,
           updated_at = NOW()
       WHERE id = $4`,
      [newUsesCount, newPaidTotal, shouldDeactivate, promotion.id],
    );
  }
 
  // ═════════════════════════════════════════════════════════════
  // PRIVATE: sentinel "MANUAL" promotion
  //   Lazy-created on first manual bonus grant. Lets us reuse the
  //   user_promotion_claims table without making promotion_id nullable.
  // ═════════════════════════════════════════════════════════════
  private async getOrCreateManualSentinel(qr: QueryRunner, adminId: number) {
    const existing = await qr.query(
      `SELECT * FROM promotions WHERE kind = 'MANUAL' AND code = '_SYS_MANUAL' LIMIT 1`,
    );
    if (existing.length) return existing[0];
 
    const created = await qr.query(
      `INSERT INTO promotions
        (title, code, kind, bonus_type, bonus_value, is_active,
         max_uses_per_user, currency, bonus_to, created_by_admin_id)
       VALUES ('Manual Admin Bonus', '_SYS_MANUAL', 'MANUAL', 'FLAT', 0,
               TRUE, 999999, 'BDT', 'BONUS_BALANCE', $1)
       RETURNING *`,
      [adminId],
    );
    return created[0];
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: CRUD
  // ═════════════════════════════════════════════════════════════
  async createPromotion(dto: CreatePromotionDto, adminId: number) {
    if (dto.kind === 'PROMOCODE' && !dto.code) {
      throw new BadRequestException('PROMOCODE kind requires a code');
    }
 
    if (dto.bonusType === 'PERCENT' && dto.bonusValue > 100) {
      throw new BadRequestException('PERCENT bonus_value cannot exceed 100');
    }
 
    if (dto.memberGroupId) {
      const grp = await this.dataSource.query(
        `SELECT id FROM member_groups WHERE id = $1 AND is_active = TRUE`,
        [dto.memberGroupId],
      );
      if (!grp.length) throw new BadRequestException('Member group not found or inactive');
    }
 
    try {
      const result = await this.dataSource.query(
        `INSERT INTO promotions
          (title, code, description, kind, bonus_type, bonus_value,
           min_amount, max_bonus, rollover_multiplier,
           member_group_id, max_uses_per_user, max_uses_global,
           max_bonus_pool, currency, bonus_to, is_active,
           starts_at, ends_at, created_by_admin_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [
          dto.title,
          dto.code ?? null,
          dto.description ?? null,
          dto.kind,
          dto.bonusType,
          dto.bonusValue,
          dto.minAmount ?? null,
          dto.maxBonus ?? null,
          dto.rolloverMultiplier ?? 0,
          dto.memberGroupId ?? null,
          dto.maxUsesPerUser ?? 1,
          dto.maxUsesGlobal ?? null,
          dto.maxBonusPool ?? null,
          dto.currency ?? 'BDT',
          dto.bonusTo ?? 'BONUS_BALANCE',
          dto.isActive ?? true,
          dto.startsAt ?? null,
          dto.endsAt ?? null,
          adminId,
        ],
      );
      return result[0];
    } catch (e: any) {
      if (e.code === '23505') {
        throw new BadRequestException(
          `A promotion with code "${dto.code}" already exists`,
        );
      }
      throw e;
    }
  }
 
  async updatePromotion(id: number, dto: UpdatePromotionDto) {
    const existing = await this.dataSource.query(
      `SELECT * FROM promotions WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Promotion not found');
 
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
 
    const map: Record<string, any> = {
      title:                dto.title,
      description:          dto.description,
      bonus_value:          dto.bonusValue,
      min_amount:           dto.minAmount,
      max_bonus:            dto.maxBonus,
      rollover_multiplier:  dto.rolloverMultiplier,
      member_group_id:      dto.memberGroupId,
      max_uses_per_user:    dto.maxUsesPerUser,
      max_uses_global:      dto.maxUsesGlobal,
      max_bonus_pool:       dto.maxBonusPool,
      is_active:            dto.isActive,
      starts_at:            dto.startsAt,
      ends_at:              dto.endsAt,
    };
 
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
 
    fields.push(`updated_at = NOW()`);
    values.push(id);
 
    const result = await this.dataSource.query(
      `UPDATE promotions SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }
 
  async deactivate(id: number) {
    const r = await this.dataSource.query(
      `UPDATE promotions SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!r.length) throw new NotFoundException('Promotion not found');
    return { message: 'Promotion deactivated' };
  }
 
  async listPromotions(q: ListPromotionsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;
 
    if (q.kind)              { where.push(`kind = $${i++}`);       params.push(q.kind); }
    if (q.isActive !== undefined) { where.push(`is_active = $${i++}`);  params.push(q.isActive); }
    if (q.currency)          { where.push(`currency = $${i++}`);   params.push(q.currency); }
 
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = q.limit ?? 20;
    const offset = ((q.page ?? 1) - 1) * limit;
 
    const data = await this.dataSource.query(
      `SELECT p.*, mg.code AS member_group_code, mg.name AS member_group_name
       FROM promotions p
       LEFT JOIN member_groups mg ON mg.id = p.member_group_id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );
 
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM promotions p ${whereSql}`,
      params,
    );
 
    return { data, page: q.page ?? 1, limit, total: count[0].total };
  }
 
  // ═════════════════════════════════════════════════════════════
  // USER: WHAT CAN I CLAIM RIGHT NOW?
  // ═════════════════════════════════════════════════════════════
  async listAvailableForUser(userId: number, kind?: PromotionKind) {
    // Get user's group memberships
    const groupsResult = await this.dataSource.query(
      `SELECT group_id FROM member_group_users WHERE user_id = $1`,
      [userId],
    );
    const userGroupIds: number[] = groupsResult.map((r: any) => Number(r.group_id));
 
    // Get the ALL group id (for sentinel match)
    const allGroup = await this.dataSource.query(
      `SELECT id FROM member_groups WHERE code = 'ALL' LIMIT 1`,
    );
    const allGroupId = allGroup.length ? Number(allGroup[0].id) : null;
 
    // Group filter: user-eligible if group is null, group is ALL, or user belongs
    let groupFilter = `p.member_group_id IS NULL`;
    if (allGroupId) groupFilter += ` OR p.member_group_id = ${allGroupId}`;
    if (userGroupIds.length) {
      groupFilter += ` OR p.member_group_id IN (${userGroupIds.join(',')})`;
    }
 
    const params: any[] = [userId];
    let kindFilter = '';
    if (kind) {
      params.push(kind);
      kindFilter = `AND p.kind = $${params.length}`;
    }
 
    return this.dataSource.query(
      `SELECT p.id, p.title, p.code, p.description, p.kind,
              p.bonus_type, p.bonus_value, p.min_amount, p.max_bonus,
              p.rollover_multiplier, p.starts_at, p.ends_at,
              p.max_uses_per_user, p.bonus_to,
              (SELECT COUNT(*)::int FROM user_promotion_claims upc
                WHERE upc.user_id = $1 AND upc.promotion_id = p.id
                AND upc.status IN ('PENDING','ACTIVE','COMPLETED')
              ) AS my_claims_count
       FROM promotions p
       WHERE p.is_active = TRUE
         AND (p.starts_at IS NULL OR p.starts_at <= NOW())
         AND (p.ends_at IS NULL OR p.ends_at > NOW())
         AND p.kind != 'MANUAL'
         AND (${groupFilter})
         ${kindFilter}
       ORDER BY p.kind, p.created_at DESC`,
      params,
    );
  }
 
  async getMyClaims(userId: number, page = 1, limit = 30) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const offset = (Math.max(page, 1) - 1) * safeLimit;
 
    const data = await this.dataSource.query(
      `SELECT upc.id, upc.bonus_amount, upc.rollover_target, upc.status,
              upc.claimed_at, upc.completed_at, upc.cancelled_at,
              p.title AS promotion_title, p.kind AS promotion_kind,
              p.code AS promotion_code,
              tr.current_amount AS turnover_progress,
              tr.target_amount  AS turnover_target,
              tr.status         AS turnover_status
       FROM user_promotion_claims upc
       JOIN promotions p ON p.id = upc.promotion_id
       LEFT JOIN turnover_requirements tr ON tr.id = upc.turnover_requirement_id
       WHERE upc.user_id = $1
       ORDER BY upc.claimed_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, safeLimit, offset],
    );
 
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM user_promotion_claims WHERE user_id = $1`,
      [userId],
    );
 
    return { data, page, limit: safeLimit, total: count[0].total };
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: VIEW CLAIMS FOR A PROMOTION
  // ═════════════════════════════════════════════════════════════
  async listClaimsForPromotion(promotionId: number, page = 1, limit = 50) {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const offset = (Math.max(page, 1) - 1) * safeLimit;
 
    const data = await this.dataSource.query(
      `SELECT upc.*, u.username, u.full_name
       FROM user_promotion_claims upc
       JOIN users u ON u.id = upc.user_id
       WHERE upc.promotion_id = $1
       ORDER BY upc.claimed_at DESC
       LIMIT $2 OFFSET $3`,
      [promotionId, safeLimit, offset],
    );
 
    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM user_promotion_claims WHERE promotion_id = $1`,
      [promotionId],
    );
 
    return { data, page, limit: safeLimit, total: count[0].total };
  }
 
  // ═════════════════════════════════════════════════════════════
  // ADMIN: CANCEL A CLAIM (reverse bonus, cancel turnover)
  // ═════════════════════════════════════════════════════════════
  async cancelClaim(dto: CancelClaimDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
 
    try {
      const claims = await qr.query(
        `SELECT * FROM user_promotion_claims WHERE id = $1 FOR UPDATE`,
        [dto.claimId],
      );
      if (!claims.length) throw new NotFoundException('Claim not found');
 
      const claim = claims[0];
      if (claim.status !== 'ACTIVE' && claim.status !== 'PENDING') {
        throw new BadRequestException(`Cannot cancel claim with status ${claim.status}`);
      }
 
      // Cancel attached turnover req if any
      if (claim.turnover_requirement_id) {
        await this.turnoverService.adminCancel(
          { requirementId: Number(claim.turnover_requirement_id), reason: dto.reason },
          adminId,
        );
      }
 
      // Mark claim cancelled
      await qr.query(
        `UPDATE user_promotion_claims
         SET status = 'CANCELLED', cancelled_at = NOW(), cancellation_reason = $1
         WHERE id = $2`,
        [dto.reason, dto.claimId],
      );
 
      // NOTE: We intentionally DO NOT debit the bonus money back from the user's
      // wallet. That's a separate "clawback" decision the admin should make
      // via /wallet/admin/adjust if warranted. Cancelling a claim just stops
      // the turnover requirement and marks the claim as void.
 
      await qr.commitTransaction();
      return {
        message: 'Claim cancelled. Bonus money was NOT clawed back automatically — ' +
                 'use admin wallet adjust if you need to recover funds.',
        claimId: claim.id,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
     
}
