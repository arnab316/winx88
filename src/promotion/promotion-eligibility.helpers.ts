// src/promotion/promotion-eligibility.helpers.ts
//
// Drop-in helpers used by PromotionEngineService.apply().
// Pulled into its own file so the existing engine doesn't get cluttered.
//
// HOW TO WIRE INTO promotion-engine.service.ts:
//   1. Import: `import * as Eligibility from './promotion-eligibility.helpers';`
//   2. Update apply() signature to accept ApplyContext (adds device,
//      ipAddress, deviceFingerprint).
//   3. Inside apply(), AFTER loading `promotion` row and BEFORE computing
//      bonusAmount, call:
//          await Eligibility.assertEligible(qr, userId, promotion, context);
//   4. When inserting into user_promotion_claims, also write
//      ip_address and device_fingerprint columns.

import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { QueryRunner } from 'typeorm';

export interface ApplyContext {
  kind: string;                       // 'DEPOSIT' | 'PROMOCODE' | 'REGISTRATION' | 'MANUAL'
  depositAmount?: number;
  device?: 'DESKTOP' | 'MOBILE_WEB' | 'APP';
  ipAddress?: string;
  deviceFingerprint?: string;
  bankAccount?: string;
}

/**
 * Master check. Throws on first failure with a descriptive message.
 * Each individual check is also exported so admins can preview
 * eligibility (e.g. "why didn't this player see this promo?").
 */
export async function assertEligible(
  qr: QueryRunner,
  userId: number,
  promotion: any,
  ctx: ApplyContext,
): Promise<void> {
  assertDevice(promotion, ctx);
  assertApplyAmountMin(promotion, ctx);
  await assertVerification(qr, userId, promotion);
  await assertFrequencyAndCooldown(qr, userId, promotion);
  await assertAntiFraud(qr, userId, promotion, ctx);
}

// ─── Device targeting ───────────────────────────────────────────
export function assertDevice(promotion: any, ctx: ApplyContext): void {
  const allowed: string[] = Array.isArray(promotion.device_types)
    ? promotion.device_types
    : JSON.parse(promotion.device_types ?? '[]');

  if (!allowed.length) return;          // unrestricted
  if (!ctx.device) return;              // can't enforce if caller didn't say
  if (!allowed.includes(ctx.device)) {
    throw new ForbiddenException(
      `This promotion is not available on ${ctx.device}`,
    );
  }
}

// ─── Apply amount minimum (separate from deposit min) ───────────
export function assertApplyAmountMin(promotion: any, ctx: ApplyContext): void {
  if (promotion.apply_amount_min === null || promotion.apply_amount_min === undefined) return;
  const required = parseFloat(promotion.apply_amount_min);
  if (!required) return;

  const supplied = ctx.depositAmount ?? 0;
  if (supplied < required) {
    throw new BadRequestException(
      `Minimum apply amount is ${required} ${promotion.currency}`,
    );
  }
}

// ─── Verification gates ─────────────────────────────────────────
export async function assertVerification(
  qr: QueryRunner,
  userId: number,
  promotion: any,
): Promise<void> {
  if (
    !promotion.require_email_verified &&
    !promotion.require_phone_verified &&
    !promotion.require_profile_verified
  ) {
    return;
  }

  const rows = await qr.query(
    `SELECT u.is_email_verified,
            (SELECT BOOL_OR(is_verified) FROM user_phone_numbers WHERE user_id = u.id) AS phone_verified,
            COALESCE((SELECT status FROM user_verifications WHERE user_id = u.id LIMIT 1), 'NONE') AS profile_status
     FROM users u
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );
  if (!rows.length) throw new ForbiddenException('User not found');

  const u = rows[0];
  if (promotion.require_email_verified && !u.is_email_verified) {
    throw new ForbiddenException('Email verification required for this promotion');
  }
  if (promotion.require_phone_verified && !u.phone_verified) {
    throw new ForbiddenException('Phone verification required for this promotion');
  }
  if (promotion.require_profile_verified && u.profile_status !== 'APPROVED') {
    throw new ForbiddenException('Profile verification required for this promotion');
  }
}

// ─── Frequency / cooldown ───────────────────────────────────────
export async function assertFrequencyAndCooldown(
  qr: QueryRunner,
  userId: number,
  promotion: any,
): Promise<void> {
  // 1. max_uses_per_user — already enforced by engine, but doubled here for safety
  const usageRows = await qr.query(
    `SELECT COUNT(*)::int AS n,
            MAX(claimed_at) AS last_claimed_at
     FROM user_promotion_claims
     WHERE user_id = $1 AND promotion_id = $2
       AND status IN ('PENDING','APPLIED','APPROVED','ACTIVE','COMPLETED')`,
    [userId, promotion.id],
  );
  const usage = usageRows[0] ?? { n: 0, last_claimed_at: null };

  const maxPerUser = Number(promotion.max_uses_per_user ?? 1);
  if (promotion.frequency !== 'UNLIMITED' && usage.n >= maxPerUser) {
    throw new ForbiddenException('You have already used this promotion the maximum number of times');
  }

  // 2. frequency window
  if (usage.last_claimed_at) {
    const last = new Date(usage.last_claimed_at);
    const now = new Date();
    const diffMs = now.getTime() - last.getTime();

    const windowMs = (() => {
      switch (promotion.frequency) {
        case 'RECURRING_DAILY':   return 24  * 60 * 60 * 1000;
        case 'RECURRING_WEEKLY':  return 7   * 24 * 60 * 60 * 1000;
        case 'RECURRING_MONTHLY': return 30  * 24 * 60 * 60 * 1000;
        default:                  return 0;
      }
    })();

    if (windowMs && diffMs < windowMs) {
      throw new ForbiddenException(
        `You can claim this promotion again later (frequency: ${promotion.frequency})`,
      );
    }
  }

  // 3. cooldown (additional explicit cooldown override)
  if (promotion.cooldown_seconds && usage.last_claimed_at) {
    const cooldownMs = Number(promotion.cooldown_seconds) * 1000;
    const diff = Date.now() - new Date(usage.last_claimed_at).getTime();
    if (diff < cooldownMs) {
      throw new ForbiddenException('Please wait before claiming this promotion again');
    }
  }
}

// ─── Anti-fraud uniqueness ──────────────────────────────────────
export async function assertAntiFraud(
  qr: QueryRunner,
  userId: number,
  promotion: any,
  ctx: ApplyContext,
): Promise<void> {
  // Each flag means: NO OTHER USER may have previously claimed this promo
  // sharing the same identifier as the current user.

  if (promotion.unique_check_email) {
    const rows = await qr.query(
      `SELECT 1
       FROM user_promotion_claims upc
       JOIN users me   ON me.id  = $1
       JOIN users them ON them.id = upc.user_id
       WHERE upc.promotion_id = $2
         AND upc.user_id != $1
         AND them.email IS NOT NULL
         AND me.email IS NOT NULL
         AND LOWER(them.email) = LOWER(me.email)
       LIMIT 1`,
      [userId, promotion.id],
    );
    if (rows.length) {
      throw new ForbiddenException('This promotion was already claimed by an account with the same email');
    }
  }

  if (promotion.unique_check_phone) {
    const rows = await qr.query(
      `SELECT 1
       FROM user_promotion_claims upc
       WHERE upc.promotion_id = $1
         AND upc.user_id != $2
         AND upc.user_id IN (
           SELECT user_id FROM user_phone_numbers
           WHERE phone_number IN (
             SELECT phone_number FROM user_phone_numbers WHERE user_id = $2
           )
         )
       LIMIT 1`,
      [promotion.id, userId],
    );
    if (rows.length) {
      throw new ForbiddenException('This promotion was already claimed by an account with the same phone');
    }
  }

  if (promotion.unique_check_ip_address && ctx.ipAddress) {
    const rows = await qr.query(
      `SELECT 1 FROM user_promotion_claims
       WHERE promotion_id = $1 AND user_id != $2 AND ip_address = $3
       LIMIT 1`,
      [promotion.id, userId, ctx.ipAddress],
    );
    if (rows.length) {
      throw new ForbiddenException('This promotion was already claimed from this IP address');
    }
  }

  if (promotion.unique_check_device_fp && ctx.deviceFingerprint) {
    const rows = await qr.query(
      `SELECT 1 FROM user_promotion_claims
       WHERE promotion_id = $1 AND user_id != $2 AND device_fingerprint = $3
       LIMIT 1`,
      [promotion.id, userId, ctx.deviceFingerprint],
    );
    if (rows.length) {
      throw new ForbiddenException('This promotion was already claimed from this device');
    }
  }

  if (promotion.unique_check_bank_account && ctx.bankAccount) {
    // Compares against bank accounts seen in deposits table by other users
    // who already claimed this promo. Adjust column name if your deposits
    // table uses a different field (e.g. account_number, bank_acc_number).
    const rows = await qr.query(
      `SELECT 1
       FROM user_promotion_claims upc
       JOIN deposits d ON d.id = upc.deposit_id
       WHERE upc.promotion_id = $1
         AND upc.user_id != $2
         AND d.account_number = $3
       LIMIT 1`,
      [promotion.id, userId, ctx.bankAccount],
    ).catch(() => []);  // tolerate schema mismatch
    if (rows.length) {
      throw new ForbiddenException('This promotion was already claimed using this bank account');
    }
  }
}