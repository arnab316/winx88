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
  ForfeitClaimDto,
  PromotionKind,
  BonusDestination,
} from './dto/promotion.dto';
import * as Eligibility from './promotion-eligibility.helpers';


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
 
    // 5. Member group eligibility — a promo may target MULTIPLE groups via
    //    promotion_member_groups. User passes if they're in ANY of them.
    //    When no groups are linked, fall back to the legacy single
    //    member_group_id (null there = open to all).
    const promoGroups = await runner.query(
      `SELECT member_group_id FROM promotion_member_groups WHERE promotion_id = $1`,
      [p.id],
    );
    let inGroup = false;
    if (promoGroups.length === 0) {
      inGroup = await this.memberGroupService.isUserInGroup(
        qr,
        userId,
        p.member_group_id,
      );
    } else {
      for (const g of promoGroups) {
        if (await this.memberGroupService.isUserInGroup(qr, userId, g.member_group_id)) {
          inGroup = true;
          break;
        }
      }
    }
    if (!inGroup) {
      throw new ForbiddenException('You are not eligible for this promotion');
    }

    // 5b. VIP-tier eligibility — when the promo restricts to specific levels,
    //     the user's vip_level must be one of them. No rows = open to all tiers.
    const promoLevels = await runner.query(
      `SELECT vip_level FROM promotion_vip_levels WHERE promotion_id = $1`,
      [p.id],
    );
    if (promoLevels.length > 0) {
      const userRow = await runner.query(
        `SELECT vip_level FROM users WHERE id = $1 LIMIT 1`,
        [userId],
      );
      const userLevel = userRow.length ? Number(userRow[0].vip_level) : null;
      const allowed = promoLevels.map((r: any) => Number(r.vip_level));
      if (userLevel === null || !allowed.includes(userLevel)) {
        throw new ForbiddenException(
          'You are not eligible for this promotion (VIP tier)',
        );
      }
    }

    // 6. Per-user use limit
    const usesByUser = await runner.query(
      `SELECT COUNT(*)::int AS c FROM user_promotion_claims
       WHERE user_id = $1 AND promotion_id = $2
         AND status IN ('PENDING','APPLIED','APPROVED','ACTIVE','COMPLETED')`,
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
  // PUBLIC API: full pre-flight for a deposit (request-time gate)
  //   Runs validateForUser PLUS the assertEligible gates (verification,
  //   device, frequency, anti-fraud) so the user gets an immediate error
  //   at deposit submission — e.g. "Phone verification required" — instead
  //   of the bonus silently being skipped at approval time.
  // ═════════════════════════════════════════════════════════════
  async assertDepositEligible(
    qr: QueryRunner,
    userId: number,
    promotionId: number,
    depositAmount: number,
    ctx: { device?: 'DESKTOP' | 'MOBILE_WEB' | 'APP'; ipAddress?: string; deviceFingerprint?: string } = {},
  ): Promise<void> {
    const { promotion } = await this.validateForUser(qr, userId, promotionId, {
      kind: 'DEPOSIT',
      depositAmount,
    });
    await Eligibility.assertEligible(qr, userId, promotion, {
      kind: 'DEPOSIT',
      depositAmount,
      device: ctx.device,
      ipAddress: ctx.ipAddress,
      deviceFingerprint: ctx.deviceFingerprint,
    });
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
      device?: 'DESKTOP' | 'MOBILE_WEB' | 'APP';
      ipAddress?: string;
      deviceFingerprint?: string;
      bankAccount?: string;
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

    // 2. Full eligibility gate (device, KYC/verification, frequency/cooldown,
    //    anti-fraud uniqueness). Throws on first failure.
    await Eligibility.assertEligible(qr, userId, promotion, {
      kind: context.kind ?? promotion.kind,
      depositAmount: context.depositAmount,
      device: context.device,
      ipAddress: context.ipAddress,
      deviceFingerprint: context.deviceFingerprint,
      bankAccount: context.bankAccount,
    });

    // 3. max_player — distinct-player cap (separate from total uses)
    if (promotion.max_player) {
      const distinct = await qr.query(
        `SELECT COUNT(DISTINCT user_id)::int AS c
           FROM user_promotion_claims
          WHERE promotion_id = $1
            AND status IN ('APPLIED','APPROVED','ACTIVE','COMPLETED')`,
        [promotion.id],
      );
      const already = await qr.query(
        `SELECT 1 FROM user_promotion_claims
          WHERE promotion_id = $1 AND user_id = $2
            AND status IN ('APPLIED','APPROVED','ACTIVE','COMPLETED')
          LIMIT 1`,
        [promotion.id, userId],
      );
      // Only block if this is a NEW player and the cap is already met.
      if (!already.length && distinct[0].c >= Number(promotion.max_player)) {
        throw new BadRequestException('Promotion player limit reached');
      }
    }

    const bonusAmount = estimatedBonus.bonusAmount;
    const bonusDest: BonusDestination = promotion.bonus_to;
    const rolloverTargetPreview = this.computeRolloverTarget(
      promotion,
      bonusAmount,
      context.depositAmount ?? 0,
    );

    // 4. Insert claim row first so we have an id for ip/fingerprint audit.
    //    Auto-approve promos go straight to ACTIVE (bonus granted below);
    //    manual-approval promos rest in APPLIED until an admin approves.
    const autoApprove = promotion.auto_approve !== false;
    const initialStatus = autoApprove ? 'ACTIVE' : 'APPLIED';

    const claimResult = await qr.query(
      `INSERT INTO user_promotion_claims
        (user_id, promotion_id, deposit_id, bonus_amount,
         rollover_target, status, meta, ip_address, device_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        userId,
        promotion.id,
        context.depositId ?? null,
        bonusAmount,
        rolloverTargetPreview,
        initialStatus,
        JSON.stringify({
          kind: context.kind,
          appliedAt: new Date().toISOString(),
          bonusType: promotion.bonus_type,
          bonusValue: parseFloat(promotion.bonus_value),
          targetType: promotion.target_type,
          targetOption: promotion.target_option,
          depositAmount: context.depositAmount ?? 0,
        }),
        context.ipAddress ?? null,
        context.deviceFingerprint ?? null,
      ],
    );
    const claimId = Number(claimResult[0].id);

    if (!autoApprove) {
      // Bonus is NOT granted yet — admin must call approveClaim().
      return {
        claimId,
        bonusAmount,
        bonusDestination: bonusDest,
        turnoverRequirementId: null,
        rolloverTarget: rolloverTargetPreview,
      };
    }

    // 5. Auto-approve: grant the bonus (credit + turnover + counters).
    const grant = await this.grantClaimBonus(qr, {
      claimId,
      userId,
      promotion,
      bonusAmount,
      depositAmount: context.depositAmount ?? 0,
      depositId: context.depositId ?? null,
      adminId: context.adminId,
      kind: context.kind,
    });

    return {
      claimId,
      bonusAmount,
      bonusDestination: bonusDest,
      turnoverRequirementId: grant.turnoverRequirementId,
      rolloverTarget: grant.rolloverTarget,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE: grant a claim's bonus (credit wallet, create turnover
  //   requirement, bump counters, mark claim ACTIVE). Shared by the
  //   auto-approve path of apply() and the admin approveClaim().
  // ═════════════════════════════════════════════════════════════
  private async grantClaimBonus(
    qr: QueryRunner,
    args: {
      claimId: number;
      userId: number;
      promotion: any;
      bonusAmount: number;
      depositAmount: number;
      depositId: number | null;
      adminId?: number;
      kind?: PromotionKind;
    },
  ): Promise<{ turnoverRequirementId: number | null; rolloverTarget: number }> {
    const { promotion, userId, bonusAmount, depositAmount } = args;
    const bonusDest: BonusDestination = promotion.bonus_to;

    // Credit the wallet
    await this.creditWallet(qr, userId, bonusAmount, bonusDest, {
      promotionId: promotion.id,
      depositId: args.depositId,
      adminId: args.adminId,
    });

    // Create turnover requirement (if a multiplier is configured)
    let turnoverReqId: number | null = null;
    let rolloverTarget = 0;
    const rolloverMult = parseFloat(promotion.rollover_multiplier);

    if (rolloverMult > 0) {
      const base = this.computeRolloverBasis(promotion, bonusAmount, depositAmount);
      const target = base * rolloverMult;

      const reqResult = await this.turnoverService['insertRequirement'](qr, {
        userId,
        sourceType: args.kind === 'REGISTRATION' ? 'BONUS' : 'PROMOTION',
        sourceId: promotion.id,
        baseAmount: base,
        multiplier: rolloverMult,
        targetAmount: target,
        adminId: args.adminId,
        // Show the promotion's name as the turnover header (e.g. "1K DoubleDown")
        // instead of the generic "Promotion turnover".
        label: promotion.title,
      } as any);

      turnoverReqId = reqResult.requirementId;
      rolloverTarget = reqResult.targetAmount;
    }

    await qr.query(
      `UPDATE user_promotion_claims
          SET status = 'ACTIVE',
              turnover_requirement_id = $1,
              rollover_target = $2
        WHERE id = $3`,
      [turnoverReqId, rolloverTarget, args.claimId],
    );

    await this.bumpCountersAndMaybeDisable(qr, promotion, bonusAmount);

    return { turnoverRequirementId: turnoverReqId, rolloverTarget };
  }
 
  // ═════════════════════════════════════════════════════════════
  // PUBLIC API: claim by promo code (no deposit attached)
  //   For PROMOCODE kind only. Issues bonus immediately.
  // ═════════════════════════════════════════════════════════════
  async claimByCode(
    userId: number,
    code: string,
    ctx: { ipAddress?: string; deviceFingerprint?: string; device?: 'DESKTOP' | 'MOBILE_WEB' | 'APP' } = {},
  ): Promise<ApplyResult> {
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
        ipAddress: ctx.ipAddress,
        deviceFingerprint: ctx.deviceFingerprint,
        device: ctx.device,
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
  // PRIVATE: wagering basis & target (honors target_option §5.2/§5.3)
  //   basis is set by target_option; required = basis × target_multiplier
  // ═════════════════════════════════════════════════════════════
  private computeRolloverBasis(
    promotion: any,
    bonusAmount: number,
    depositAmount: number,
  ): number {
    switch (promotion.target_option) {
      case 'BONUS_ONLY':
        return bonusAmount;
      case 'APPLY_ONLY':
        return depositAmount;
      case 'BONUS_AND_APPLY':
      default:
        return bonusAmount + depositAmount;
    }
  }

  private computeRolloverTarget(
    promotion: any,
    bonusAmount: number,
    depositAmount: number,
  ): number {
    const mult = parseFloat(promotion.rollover_multiplier ?? '0');
    if (!mult || mult <= 0) return 0;
    const basis = this.computeRolloverBasis(promotion, bonusAmount, depositAmount);
    return Math.floor(basis * mult * 100) / 100;
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
  // Replace a promotion's member-group set with the given ids (validates each
  // is an active group). An empty array clears all groups. Used by create and
  // update to keep promotion_member_groups in sync.
  private async syncMemberGroups(
    runner: any,
    promotionId: number,
    groupIds: number[],
  ): Promise<void> {
    const unique = [...new Set(groupIds)];
    if (unique.length) {
      const found = await runner.query(
        `SELECT id FROM member_groups WHERE id = ANY($1) AND is_active = TRUE`,
        [unique],
      );
      if (found.length !== unique.length) {
        throw new BadRequestException(
          'One or more member groups not found or inactive',
        );
      }
    }
    await runner.query(
      `DELETE FROM promotion_member_groups WHERE promotion_id = $1`,
      [promotionId],
    );
    for (const gid of unique) {
      await runner.query(
        `INSERT INTO promotion_member_groups (promotion_id, member_group_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [promotionId, gid],
      );
    }
  }

  // Replace a promotion's VIP-tier set (validates each level is an active
  // vip_level_config row). Empty array clears all. Used by create and update.
  private async syncVipLevels(
    runner: any,
    promotionId: number,
    levels: number[],
  ): Promise<void> {
    const unique = [...new Set(levels)];
    if (unique.length) {
      const found = await runner.query(
        `SELECT level FROM vip_level_config WHERE level = ANY($1) AND status = 'ACTIVE'`,
        [unique],
      );
      if (found.length !== unique.length) {
        throw new BadRequestException('One or more VIP levels not found or inactive');
      }
    }
    await runner.query(
      `DELETE FROM promotion_vip_levels WHERE promotion_id = $1`,
      [promotionId],
    );
    for (const lvl of unique) {
      await runner.query(
        `INSERT INTO promotion_vip_levels (promotion_id, vip_level)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [promotionId, lvl],
      );
    }
  }

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
 
    if (dto.linkedPromotionId) {
      const linked = await this.dataSource.query(
        `SELECT id FROM promotions WHERE id = $1`,
        [dto.linkedPromotionId],
      );
      if (!linked.length) throw new BadRequestException('Linked promotion not found');
    }

    try {
      const result = await this.dataSource.query(
        `INSERT INTO promotions
          (title, code, description, kind, bonus_type, bonus_value,
           min_amount, apply_amount_min, max_bonus, rollover_multiplier,
           member_group_id, max_uses_per_user, max_uses_global,
           max_bonus_pool, currency, bonus_to, is_active,
           starts_at, ends_at, created_by_admin_id,
           device_types, frequency, cooldown_seconds, eligible_game_categories,
           auto_unlock_threshold,
           unique_check_bank_account, unique_check_email, unique_check_ip_address,
           unique_check_device_fp, unique_check_phone,
           require_email_verified, require_phone_verified, require_profile_verified,
           linked_promotion_id, auto_approve, auto_complete, allow_cancel,
           cancel_threshold, forfeit_type, maximum_withdrawal, amount_cap,
           cap_limit_type, balance_require, remove_max_withdraw_lock,
           target_type, target_option, max_player, pay_later,
           display_if_non_eligible, hide_if_eligible,
           limit_to_provider, check_by_wallet_balance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,
                 $39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51,$52)
         RETURNING *`,
        [
          dto.title,
          dto.code ?? null,
          dto.description ?? null,
          dto.kind,
          dto.bonusType,
          dto.bonusValue,
          dto.minAmount ?? null,
          dto.applyAmountMin ?? null,
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
          // jsonb columns are NOT NULL — fall back to their schema defaults
          dto.deviceTypes
            ? JSON.stringify(dto.deviceTypes)
            : '["DESKTOP","MOBILE_WEB","APP"]',
          dto.frequency ?? 'ONE_TIME',
          dto.cooldownSeconds ?? null,
          dto.eligibleGameCategories
            ? JSON.stringify(dto.eligibleGameCategories)
            : '[]',
          dto.autoUnlockThreshold ?? null,
          dto.uniqueCheckBankAccount ?? false,
          dto.uniqueCheckEmail ?? false,
          dto.uniqueCheckIpAddress ?? false,
          dto.uniqueCheckDeviceFp ?? false,
          dto.uniqueCheckPhone ?? false,
          dto.requireEmailVerified ?? false,
          dto.requirePhoneVerified ?? false,
          dto.requireProfileVerified ?? false,
          dto.linkedPromotionId ?? null,
          dto.autoApprove ?? true,
          dto.autoComplete ?? false,
          dto.allowCancel ?? false,
          dto.cancelThreshold ?? null,
          dto.forfeitType ?? 'BONUS',
          dto.maximumWithdrawal ?? null,
          dto.amountCap ?? null,
          dto.capLimitType ?? null,
          dto.balanceRequire ?? null,
          dto.removeMaxWithdrawLock ?? false,
          dto.targetType ?? 'TURNOVER',
          dto.targetOption ?? 'BONUS_AND_APPLY',
          dto.maxPlayer ?? null,
          dto.payLater ?? false,
          dto.displayIfNonEligible ?? true,
          dto.hideIfEligible ?? false,
          dto.limitToProvider ?? false,
          dto.checkByWalletBalance ?? false,
        ],
      );
      let created = result[0];

      // Register-valid-days isn't in the big INSERT above; set it post-insert.
      if (dto.registerValidDays !== undefined) {
        const upd = await this.dataSource.query(
          `UPDATE promotions SET register_valid_days = $1, updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [dto.registerValidDays, created.id],
        );
        created = upd[0];
      }

      // Multi member-group eligibility (join table). Accept memberGroupIds, or
      // fall back to a single memberGroupId for backward compatibility.
      const groupIds =
        dto.memberGroupIds ??
        (dto.memberGroupId ? [dto.memberGroupId] : []);
      if (groupIds.length) {
        await this.syncMemberGroups(this.dataSource, created.id, groupIds);
      }

      // VIP-tier eligibility (join table).
      if (dto.vipLevels && dto.vipLevels.length) {
        await this.syncVipLevels(this.dataSource, created.id, dto.vipLevels);
      }

      return created;
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
      bonus_type:           dto.bonusType,
      kind:                 dto.kind,
      bonus_value:          dto.bonusValue,
      min_amount:           dto.minAmount,
      apply_amount_min:     dto.applyAmountMin,
      max_bonus:            dto.maxBonus,
      rollover_multiplier:  dto.rolloverMultiplier,
      register_valid_days:  dto.registerValidDays,
      member_group_id:      dto.memberGroupId,
      max_uses_per_user:    dto.maxUsesPerUser,
      max_uses_global:      dto.maxUsesGlobal,
      max_bonus_pool:       dto.maxBonusPool,
      is_active:            dto.isActive,
      starts_at:            dto.startsAt,
      ends_at:              dto.endsAt,
      frequency:            dto.frequency,
      cooldown_seconds:     dto.cooldownSeconds,
      auto_unlock_threshold: dto.autoUnlockThreshold,
      unique_check_bank_account: dto.uniqueCheckBankAccount,
      unique_check_email:        dto.uniqueCheckEmail,
      unique_check_ip_address:   dto.uniqueCheckIpAddress,
      unique_check_device_fp:    dto.uniqueCheckDeviceFp,
      unique_check_phone:        dto.uniqueCheckPhone,
      require_email_verified:    dto.requireEmailVerified,
      require_phone_verified:    dto.requirePhoneVerified,
      require_profile_verified:  dto.requireProfileVerified,
      linked_promotion_id:       dto.linkedPromotionId,
      auto_approve:              dto.autoApprove,
      auto_complete:             dto.autoComplete,
      allow_cancel:              dto.allowCancel,
      cancel_threshold:          dto.cancelThreshold,
      forfeit_type:              dto.forfeitType,
      maximum_withdrawal:        dto.maximumWithdrawal,
      amount_cap:                dto.amountCap,
      cap_limit_type:            dto.capLimitType,
      balance_require:           dto.balanceRequire,
      remove_max_withdraw_lock:  dto.removeMaxWithdrawLock,
      target_type:               dto.targetType,
      target_option:             dto.targetOption,
      max_player:                dto.maxPlayer,
      pay_later:                 dto.payLater,
      display_if_non_eligible:   dto.displayIfNonEligible,
      hide_if_eligible:          dto.hideIfEligible,
      limit_to_provider:         dto.limitToProvider,
      check_by_wallet_balance:   dto.checkByWalletBalance,
    };

    // jsonb array fields need explicit serialization
    const jsonbMap: Record<string, any> = {
      device_types:             dto.deviceTypes,
      eligible_game_categories: dto.eligibleGameCategories,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    for (const [col, val] of Object.entries(jsonbMap)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(JSON.stringify(val));
      }
    }
    // memberGroupIds / vipLevels can be the only change, so allow an update
    // with no scalar fields when either is present (empty array = clear).
    if (
      !fields.length &&
      dto.memberGroupIds === undefined &&
      dto.vipLevels === undefined
    ) {
      throw new BadRequestException('No fields to update');
    }

    let row = existing[0];
    if (fields.length) {
      fields.push(`updated_at = NOW()`);
      values.push(id);
      const result = await this.dataSource.query(
        `UPDATE promotions SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
      row = result[0];
    }

    // Sync multi member-group eligibility when provided.
    if (dto.memberGroupIds !== undefined) {
      await this.syncMemberGroups(this.dataSource, id, dto.memberGroupIds);
    }
    // Sync VIP-tier eligibility when provided.
    if (dto.vipLevels !== undefined) {
      await this.syncVipLevels(this.dataSource, id, dto.vipLevels);
    }

    return row;
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

  // DELETE /promotion/admin/:id           → soft delete (deactivate)
  // DELETE /promotion/admin/:id?hard=true → permanent delete (only if unused)
  async deletePromotion(id: number, hard = false) {
    const existing = await this.dataSource.query(
      `SELECT id FROM promotions WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Promotion not found');

    if (!hard) {
      await this.dataSource.query(
        `UPDATE promotions SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return { message: 'Promotion deactivated', id, mode: 'SOFT' };
    }

    // Hard delete: refuse if anything references this promotion (would orphan
    // claims/deposits or break a CMS card / linked promo).
    const [refs] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM user_promotion_claims WHERE promotion_id = $1)::int AS claims,
         (SELECT COUNT(*) FROM deposits             WHERE promotion_id = $1)::int AS deposits,
         (SELECT COUNT(*) FROM promotion_cms        WHERE promotion_id = $1)::int AS cms_cards,
         (SELECT COUNT(*) FROM promotions           WHERE linked_promotion_id = $1)::int AS linked`,
      [id],
    );

    const blocking: string[] = [];
    if (refs.claims    > 0) blocking.push(`${refs.claims} claim(s)`);
    if (refs.deposits  > 0) blocking.push(`${refs.deposits} deposit(s)`);
    if (refs.cms_cards > 0) blocking.push(`${refs.cms_cards} CMS card(s)`);
    if (refs.linked    > 0) blocking.push(`${refs.linked} linked promotion(s)`);
    if (blocking.length) {
      throw new BadRequestException(
        `Cannot permanently delete: ${blocking.join(', ')} reference this promotion. ` +
          `Deactivate it instead, or remove those references first.`,
      );
    }

    try {
      await this.dataSource.query(`DELETE FROM promotions WHERE id = $1`, [id]);
    } catch (e: any) {
      if (e?.code === '23503') {
        throw new BadRequestException(
          'Cannot permanently delete: other records reference this promotion. Deactivate instead.',
        );
      }
      throw e;
    }
    return { message: 'Promotion permanently deleted', id, mode: 'HARD' };
  }
 
async listPromotions(q: ListPromotionsQueryDto) {
  const where: string[] = [];
  const params: any[] = [];
  let i = 1;
 
  if (q.kind)                    { where.push(`p.kind = $${i++}`);                params.push(q.kind); }
  if (q.isActive !== undefined)  { where.push(`p.is_active = $${i++}`);           params.push(q.isActive); }
  if (q.currency)                { where.push(`p.currency = $${i++}`);            params.push(q.currency); }
  if (q.code)                    { where.push(`p.code = $${i++}`);                params.push(q.code); }
 
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
 
  const page  = Math.max(q.page  ?? 1,  1);
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 200);
  const offset = (page - 1) * limit;
 
  params.push(limit, offset);
 
  const data = await this.dataSource.query(
    `SELECT p.*,
            mg.code AS member_group_code,
            mg.name AS member_group_name,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'id', mg2.id, 'code', mg2.code, 'name', mg2.name)
                       ORDER BY mg2.id)
              FROM promotion_member_groups pmg
              JOIN member_groups mg2 ON mg2.id = pmg.member_group_id
              WHERE pmg.promotion_id = p.id
            ), '[]'::json) AS member_groups,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'level', vc.level, 'name', vc.level_name)
                       ORDER BY vc.level)
              FROM promotion_vip_levels pvl
              JOIN vip_level_config vc ON vc.level = pvl.vip_level
              WHERE pvl.promotion_id = p.id
            ), '[]'::json) AS vip_levels
     FROM promotions p
     LEFT JOIN member_groups mg ON mg.id = p.member_group_id
     ${whereSql}
     ORDER BY p.created_at DESC
     LIMIT $${i++} OFFSET $${i++}`,
    params,
  );
 
  // Count for pagination — slice off the LIMIT/OFFSET params
  const totalRows = await this.dataSource.query(
    `SELECT COUNT(*)::int AS total
     FROM promotions p
     ${whereSql}`,
    params.slice(0, -2),
  );
 
  return {
    data,
    page,
    limit,
    total: totalRows[0].total,
  };
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
                AND upc.status IN ('PENDING','APPLIED','APPROVED','ACTIVE','COMPLETED')
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

  // ═════════════════════════════════════════════════════════════
  // ADMIN: APPROVE A CLAIM (manual-approval promos)
  //   Moves an APPLIED claim to ACTIVE and actually grants the bonus
  //   (credit wallet, create turnover requirement, bump counters).
  // ═════════════════════════════════════════════════════════════
  async approveClaim(claimId: number, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const claims = await qr.query(
        `SELECT * FROM user_promotion_claims WHERE id = $1 FOR UPDATE`,
        [claimId],
      );
      if (!claims.length) throw new NotFoundException('Claim not found');
      const claim = claims[0];

      if (claim.status !== 'APPLIED') {
        throw new BadRequestException(
          `Only APPLIED claims can be approved (current: ${claim.status})`,
        );
      }

      const promoRows = await qr.query(
        `SELECT * FROM promotions WHERE id = $1`,
        [claim.promotion_id],
      );
      if (!promoRows.length) throw new NotFoundException('Promotion not found');
      const promotion = promoRows[0];

      const meta = claim.meta ?? {};
      const grant = await this.grantClaimBonus(qr, {
        claimId,
        userId: Number(claim.user_id),
        promotion,
        bonusAmount: parseFloat(claim.bonus_amount),
        depositAmount: Number(meta.depositAmount ?? 0),
        depositId: claim.deposit_id ? Number(claim.deposit_id) : null,
        adminId,
        kind: meta.kind,
      });

      await qr.query(
        `UPDATE user_promotion_claims
            SET approved_at = NOW(), approved_by_admin_id = $1
          WHERE id = $2`,
        [adminId, claimId],
      );

      await qr.commitTransaction();
      return {
        message: 'Claim approved and bonus granted',
        claimId,
        turnoverRequirementId: grant.turnoverRequirementId,
        rolloverTarget: grant.rolloverTarget,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: FORFEIT A CLAIM
  //   forfeit_type BONUS  → strip the remaining bonus balance only
  //   forfeit_type WALLET → strip bonus + locked balance entirely
  //   Cancels any attached turnover requirement and writes a ledger entry.
  // ═════════════════════════════════════════════════════════════
  async forfeitClaim(dto: ForfeitClaimDto, adminId: number) {
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

      if (!['APPLIED', 'APPROVED', 'ACTIVE'].includes(claim.status)) {
        throw new BadRequestException(
          `Cannot forfeit a claim with status ${claim.status}`,
        );
      }

      // Cancel attached turnover requirement, if any
      if (claim.turnover_requirement_id) {
        await this.turnoverService.adminCancel(
          { requirementId: Number(claim.turnover_requirement_id), reason: dto.reason },
          adminId,
        );
      }

      // Strip funds from the wallet (only if the bonus was actually granted —
      // APPLIED claims never credited anything, so nothing to claw back).
      if (claim.status !== 'APPLIED') {
        const wRows = await qr.query(
          `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
          [claim.user_id],
        );
        if (wRows.length) {
          const w = wRows[0];
          const balBefore = parseFloat(w.balance);
          const bonBefore = parseFloat(w.bonus_balance);
          const lckBefore = parseFloat(w.locked_balance);

          let bonAfter = bonBefore;
          let lckAfter = lckBefore;

          if (dto.forfeitType === 'WALLET') {
            // Forfeit the entire bonus-derived holding
            bonAfter = 0;
            lckAfter = 0;
          } else {
            // BONUS: claw back up to the granted bonus amount from bonus_balance
            const claw = Math.min(parseFloat(claim.bonus_amount), bonBefore);
            bonAfter = bonBefore - claw;
          }

          const stripped = (bonBefore - bonAfter) + (lckBefore - lckAfter);
          await qr.query(
            `UPDATE wallets
                SET bonus_balance = $1, locked_balance = $2, updated_at = NOW()
              WHERE id = $3`,
            [bonAfter, lckAfter, w.id],
          );

          // Ledger requires amount > 0 — only record if funds actually moved
          if (stripped > 0) {
            await this.financialLedger.write({
              qr,
              walletId: w.id,
              userId: Number(claim.user_id),
              entryType: 'MANUAL_ADJUSTMENT',
              flow: 'DEBIT',
              amount: stripped,
              balanceBefore: balBefore,
              balanceAfter: balBefore,
              bonusBefore: bonBefore,
              bonusAfter: bonAfter,
              lockedBefore: lckBefore,
              lockedAfter: lckAfter,
              referenceType: 'PROMOTION',
              referenceId: Number(claim.promotion_id),
              status: 'SUCCESS',
              description: `Bonus forfeited (${dto.forfeitType}): ${dto.reason}`,
              meta: { claimId: claim.id, forfeitType: dto.forfeitType },
              createdByType: 'ADMIN',
              createdById: adminId,
            });
          }
        }
      }

      await qr.query(
        `UPDATE user_promotion_claims
            SET status = 'FORFEITED', forfeited_at = NOW(),
                forfeit_type = $1, forfeit_reason = $2
          WHERE id = $3`,
        [dto.forfeitType, dto.reason, dto.claimId],
      );

      await qr.commitTransaction();
      return { message: 'Claim forfeited', claimId: claim.id, forfeitType: dto.forfeitType };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
}
