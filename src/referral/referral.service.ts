import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { generateReferralCode } from '../auth/utils';

/**
 * Read-side of the refer-a-friend system (Phase 1).
 *
 * Lifecycle/progression (deposit + turnover tracking, completion, expiry,
 * bonus credit, wagering) lands in later phases — see the roadmap. This service
 * only exposes the referrer-facing link + their referrals list for now.
 */
@Injectable()
export class ReferralService {
  constructor(private readonly dataSource: DataSource) {}

  // The referrer's invite link + headline stats. Lazily issues a referral_code
  // for legacy users who registered before codes were generated.
  async getMyLink(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT referral_code, user_code FROM users WHERE id = $1`,
      [userId],
    );
    if (!rows.length) throw new NotFoundException('User not found');

    let code: string = rows[0].referral_code;
    if (!code) {
      code = await this.ensureReferralCode(userId, rows[0].user_code ?? 'USER');
    }

    const base = process.env.PUBLIC_SITE_URL ?? 'https://winx-88.com';
    const [agg] = await this.dataSource.query(
      `SELECT
         COALESCE(total_referrals_sent, 0)           AS total,
         COALESCE(total_referrals_converted, 0)      AS converted,
         COALESCE(total_bonus_earned, 0)             AS bonus_earned,
         COALESCE(referrer_turnover_unlocked, false) AS turnover_unlocked
       FROM referral_status WHERE user_id = $1`,
      [userId],
    );

    return {
      referral_code: code,
      referral_url: `${base}/register?ref=${code}`,
      total_referrals: Number(agg?.total ?? 0),
      converted: Number(agg?.converted ?? 0),
      total_bonus_earned: Number(agg?.bonus_earned ?? 0),
      turnover_unlocked: Boolean(agg?.turnover_unlocked ?? false),
    };
  }

  // Set referral_code if still NULL, then read it back. We deliberately do NOT
  // rely on `UPDATE ... RETURNING`'s result shape — TypeORM's .query() returns
  // it differently for UPDATE vs INSERT, which silently yielded `undefined`.
  // Tolerates races (already set elsewhere) and unique-code clashes.
  private async ensureReferralCode(userId: number, seed: string): Promise<string> {
    for (let i = 0; i < 6; i++) {
      const candidate = generateReferralCode(seed);
      try {
        await this.dataSource.query(
          `UPDATE users SET referral_code = $1
            WHERE id = $2 AND referral_code IS NULL`,
          [candidate, userId],
        );
      } catch (e: any) {
        if (e.code === '23505') continue; // code already taken — try another
        throw e;
      }
      // Whether we just set it or it was already set, return the live value.
      const [row] = await this.dataSource.query(
        `SELECT referral_code FROM users WHERE id = $1`,
        [userId],
      );
      if (row?.referral_code) return row.referral_code;
    }
    throw new Error('Could not generate a unique referral code');
  }

  // The referrer's referrals with both sides' progress against the snapshotted
  // targets, so the UI can render progress bars without extra lookups.
  async getMyReferrals(userId: number) {
    const rows = await this.dataSource.query(
      `SELECT
         r.id, r.status, r.started_at, r.expires_at, r.completed_at,
         r.referrer_deposit_total, r.referee_deposit_total,
         r.referrer_turnover_total, r.referee_turnover_total,
         r.referrer_deposit_met, r.referee_deposit_met,
         r.referrer_turnover_met, r.referee_turnover_met,
         r.config_bonus_amount,
         r.config_referrer_dep_min, r.config_referee_dep_min,
         r.config_referrer_turn_min, r.config_referee_turn_min,
         u.username AS referee_username
       FROM friend_referrals r
       JOIN users u ON u.id = r.referee_user_id
       WHERE r.referrer_user_id = $1
       ORDER BY r.started_at DESC`,
      [userId],
    );

    return rows.map((r: any) => ({
      id: Number(r.id),
      status: r.status,
      refereeUsername: r.referee_username,
      startedAt: r.started_at,
      expiresAt: r.expires_at,
      completedAt: r.completed_at,
      bonusAmount: Number(r.config_bonus_amount),
      referee: {
        depositTotal: Number(r.referee_deposit_total),
        depositTarget: Number(r.config_referee_dep_min),
        depositMet: r.referee_deposit_met,
        turnoverTotal: Number(r.referee_turnover_total),
        turnoverTarget: Number(r.config_referee_turn_min),
        turnoverMet: r.referee_turnover_met,
      },
      referrer: {
        depositTotal: Number(r.referrer_deposit_total),
        depositTarget: Number(r.config_referrer_dep_min),
        depositMet: r.referrer_deposit_met,
        turnoverTotal: Number(r.referrer_turnover_total),
        turnoverTarget: Number(r.config_referrer_turn_min),
        turnoverMet: r.referrer_turnover_met,
      },
    }));
  }
}
