import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, QueryRunner } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import { SHARED_DEVICE_OR_IP_SQL, describeShared } from './referral-fraud.util';

/**
 * Phase 2 — the refer-a-friend lifecycle engine.
 *
 * Moves a `friend_referrals` row PENDING → ACTIVE → BONUS_CLEARING → DONE
 * (or EXPIRED via the cron) by reacting to two platform events:
 *
 *   onDeposit(qr,user,amt)     — hooked in wallet.decideDeposit() on APPROVE
 *   onBetSettled(qr,user,stake)— hooked in turnover.contributeFromSettledBet()
 *                                (the single chokepoint for ALL bet products)
 *
 * Both run inside the host transaction but wrap their work in a SAVEPOINT, so a
 * referral failure is isolated and can NEVER roll back or break the deposit/bet.
 *
 * Rules (snapshotted per referral at creation, read from the row's config_*):
 *   - referrer + referee each need their deposit + turnover minimums in-window
 *   - referrer turnover is a ONE-TIME lifetime unlock (referral_status)
 *   - on completion the referrer is credited config_bonus_amount to bonus_balance
 *     and must wager bonus × config_wagering_mult to reach DONE
 */
@Injectable()
export class ReferralEngineService {
  private readonly logger = new Logger(ReferralEngineService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly financialLedger: FinancialLedgerService,
  ) {}

  // ── Deposit progress (referrer can have many referrals; referee at most one) ──
  async onDeposit(qr: QueryRunner, userId: number, amount: number): Promise<void> {
    if (!amount || amount <= 0) return;
    await this.isolated(qr, 'ref_dep', async () => {
      const asReferrer = await qr.query(
        `SELECT id, referrer_deposit_total, config_referrer_dep_min
           FROM friend_referrals
          WHERE referrer_user_id = $1 AND status IN ('PENDING','ACTIVE') AND expires_at > NOW()
          FOR UPDATE`,
        [userId],
      );
      for (const r of asReferrer) {
        const total = Number(r.referrer_deposit_total) + amount;
        const met = total >= Number(r.config_referrer_dep_min);
        await qr.query(
          `UPDATE friend_referrals
              SET referrer_deposit_total = $1, referrer_deposit_met = $2,
                  status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
                  updated_at = NOW()
            WHERE id = $3`,
          [total, met, r.id],
        );
        await this.tryComplete(qr, Number(r.id));
      }

      const asReferee = await qr.query(
        `SELECT id, referee_deposit_total, config_referee_dep_min
           FROM friend_referrals
          WHERE referee_user_id = $1 AND status IN ('PENDING','ACTIVE') AND expires_at > NOW()
          FOR UPDATE`,
        [userId],
      );
      for (const r of asReferee) {
        const total = Number(r.referee_deposit_total) + amount;
        const met = total >= Number(r.config_referee_dep_min);
        await qr.query(
          `UPDATE friend_referrals
              SET referee_deposit_total = $1, referee_deposit_met = $2,
                  status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
                  updated_at = NOW()
            WHERE id = $3`,
          [total, met, r.id],
        );
        await this.tryComplete(qr, Number(r.id));
      }
    });
  }

  // ── Turnover progress + lifetime unlock + bonus wagering ──
  async onBetSettled(qr: QueryRunner, userId: number, stake: number): Promise<void> {
    if (!stake || stake <= 0) return;
    await this.isolated(qr, 'ref_bet', async () => {
      // 1. Referee turnover (this user is a referee in at most one referral).
      const asReferee = await qr.query(
        `SELECT id, referee_turnover_total, config_referee_turn_min
           FROM friend_referrals
          WHERE referee_user_id = $1 AND status IN ('PENDING','ACTIVE') AND expires_at > NOW()
          FOR UPDATE`,
        [userId],
      );
      for (const r of asReferee) {
        const total = Number(r.referee_turnover_total) + stake;
        const met = total >= Number(r.config_referee_turn_min);
        await qr.query(
          `UPDATE friend_referrals
              SET referee_turnover_total = $1, referee_turnover_met = $2,
                  status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
                  updated_at = NOW()
            WHERE id = $3`,
          [total, met, r.id],
        );
        await this.tryComplete(qr, Number(r.id));
      }

      // 2. Referrer turnover — only while the lifetime unlock is still OFF.
      const unlocked = await this.isReferrerUnlocked(qr, userId);
      if (!unlocked) {
        const asReferrer = await qr.query(
          `SELECT id, referrer_turnover_total, config_referrer_turn_min
             FROM friend_referrals
            WHERE referrer_user_id = $1 AND status IN ('PENDING','ACTIVE')
              AND expires_at > NOW() AND referrer_turnover_met = false
            FOR UPDATE`,
          [userId],
        );
        let crossed = false;
        for (const r of asReferrer) {
          const total = Number(r.referrer_turnover_total) + stake;
          const met = total >= Number(r.config_referrer_turn_min);
          await qr.query(
            `UPDATE friend_referrals
                SET referrer_turnover_total = $1, referrer_turnover_met = $2,
                    status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END,
                    updated_at = NOW()
              WHERE id = $3`,
            [total, met, r.id],
          );
          if (met) crossed = true;
        }

        if (crossed) {
          // Flip the lifetime unlock and satisfy the referrer side on ALL their
          // active referrals (the target is per-account, not per-referral).
          await qr.query(
            `INSERT INTO referral_status (user_id, referrer_turnover_unlocked, referrer_turnover_unlocked_at)
             VALUES ($1, true, NOW())
             ON CONFLICT (user_id) DO UPDATE
               SET referrer_turnover_unlocked = true,
                   referrer_turnover_unlocked_at = COALESCE(referral_status.referrer_turnover_unlocked_at, NOW()),
                   updated_at = NOW()`,
            [userId],
          );
          await qr.query(
            `UPDATE friend_referrals SET referrer_turnover_met = true, updated_at = NOW()
              WHERE referrer_user_id = $1 AND status IN ('PENDING','ACTIVE')`,
            [userId],
          );
        }

        // Re-evaluate every active referral the referrer owns.
        const active = await qr.query(
          `SELECT id FROM friend_referrals
            WHERE referrer_user_id = $1 AND status IN ('PENDING','ACTIVE')`,
          [userId],
        );
        for (const r of active) await this.tryComplete(qr, Number(r.id));
      }

      // 3. Bonus wagering — the referrer clearing their credited ৳bonus.
      await this.contributeBonusWagering(qr, userId, stake);
    });
  }

  private async isReferrerUnlocked(qr: QueryRunner, userId: number): Promise<boolean> {
    const [s] = await qr.query(
      `SELECT referrer_turnover_unlocked FROM referral_status WHERE user_id = $1`,
      [userId],
    );
    return !!(s && s.referrer_turnover_unlocked);
  }

  private async contributeBonusWagering(
    qr: QueryRunner,
    userId: number,
    stake: number,
  ): Promise<void> {
    const rows = await qr.query(
      `SELECT id, referral_id, wagering_required, wagering_completed
         FROM referral_bonus_wagering
        WHERE referrer_user_id = $1 AND is_cleared = false
        FOR UPDATE`,
      [userId],
    );
    for (const r of rows) {
      const done = Number(r.wagering_completed) + stake;
      const cleared = done >= Number(r.wagering_required);
      await qr.query(
        `UPDATE referral_bonus_wagering
            SET wagering_completed = $1, is_cleared = $2, cleared_at = $3, updated_at = NOW()
          WHERE id = $4`,
        [done, cleared, cleared ? new Date() : null, r.id],
      );
      if (cleared) {
        await qr.query(
          `UPDATE friend_referrals SET status = 'DONE', updated_at = NOW()
            WHERE id = $1 AND status = 'BONUS_CLEARING'`,
          [r.referral_id],
        );
        this.logger.log(
          `Referral ${r.referral_id} bonus wagering cleared → DONE (referrer ${userId})`,
        );
      }
    }
  }

  // ── Completion: all four targets met in-window → credit bonus, BONUS_CLEARING ──
  private async tryComplete(qr: QueryRunner, referralId: number): Promise<void> {
    const [r] = await qr.query(
      `SELECT * FROM friend_referrals WHERE id = $1 FOR UPDATE`,
      [referralId],
    );
    if (!r) return;
    if (r.status !== 'PENDING' && r.status !== 'ACTIVE') return;
    // A target of 0 (or less) is satisfied by default: there is no deposit/bet
    // event that would otherwise ever flip its `*_met` flag, so a 0-minimum
    // requirement must count as met even with no activity on that side.
    const allMet =
      (r.referrer_deposit_met  || Number(r.config_referrer_dep_min)  <= 0) &&
      (r.referee_deposit_met   || Number(r.config_referee_dep_min)   <= 0) &&
      (r.referrer_turnover_met || Number(r.config_referrer_turn_min) <= 0) &&
      (r.referee_turnover_met  || Number(r.config_referee_turn_min)  <= 0);
    if (!allMet) return;
    if (new Date(r.expires_at) <= new Date()) return; // expired — cron will flip it

    const referrerId = Number(r.referrer_user_id);
    const refereeId = Number(r.referee_user_id);
    const bonus = Number(r.config_bonus_amount);
    const multiplier = Number(r.config_wagering_mult);

    // Fraud gate: never pay a bonus when referrer & referee share a device
    // fingerprint or IP (self-referral / fake accounts). Disqualify instead.
    const [fraudRow] = await qr.query(SHARED_DEVICE_OR_IP_SQL, [referrerId, refereeId]);
    const fraud = describeShared(fraudRow);
    if (fraud.shared) {
      await qr.query(
        `UPDATE friend_referrals
            SET status = 'DISQUALIFIED', disqualification_reason = $2, updated_at = NOW()
          WHERE id = $1`,
        [referralId, `Auto-detected: ${fraud.reason}`],
      );
      this.logger.warn(
        `Referral ${referralId} auto-DISQUALIFIED (${fraud.reason}); referrer ${referrerId}, referee ${refereeId} — bonus withheld`,
      );
      return;
    }

    // No bonus to a non-ACTIVE referrer — mark completed, withhold, flag.
    const [referrer] = await qr.query(
      `SELECT account_status FROM users WHERE id = $1`,
      [referrerId],
    );
    if (!referrer || referrer.account_status !== 'ACTIVE') {
      await qr.query(
        `UPDATE friend_referrals SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [referralId],
      );
      this.logger.warn(
        `Referral ${referralId} completed but referrer ${referrerId} not ACTIVE — bonus withheld`,
      );
      return;
    }

    // Credit the bonus. Mirrors the promotion-bonus model: the amount is added
    // to the spendable main `balance` (so the referrer can play with it) AND
    // mirrored into `bonus_balance` so admins can see how much of the balance is
    // bonus — withdrawal stays gated by the wagering requirement below.
    const [w] = await qr.query(
      `SELECT id, balance, bonus_balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [referrerId],
    );
    if (!w) {
      await qr.query(
        `UPDATE friend_referrals SET status = 'COMPLETED', completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [referralId],
      );
      this.logger.warn(`Referral ${referralId}: referrer ${referrerId} has no wallet — bonus withheld`);
      return;
    }
    const balanceBefore = Number(w.balance);
    const bonusBefore = Number(w.bonus_balance);
    const balanceAfter = balanceBefore + bonus;
    const bonusAfter = bonusBefore + bonus;

    await qr.query(
      `UPDATE wallets SET balance = $1, bonus_balance = $2, updated_at = NOW() WHERE id = $3`,
      [balanceAfter, bonusAfter, w.id],
    );

    // Bonus wagering tracker (the audit + clearing record for this bonus).
    const wageringRequired = bonus * multiplier;
    await qr.query(
      `INSERT INTO referral_bonus_wagering
         (referral_id, referrer_user_id, bonus_amount, wagering_required, bonus_credited_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (referral_id) DO NOTHING`,
      [referralId, referrerId, bonus, wageringRequired],
    );

    await this.financialLedger.write({
      qr,
      walletId: Number(w.id),
      userId: referrerId,
      entryType: 'REFERRAL_BONUS_CREDIT',
      flow: 'CREDIT',
      amount: bonus,
      balanceBefore,
      balanceAfter, // bonus added to spendable balance (mirrored in bonus_balance)
      bonusBefore,
      bonusAfter,
      referenceType: 'REFERRAL_BONUS',
      referenceId: referralId,
      status: 'SUCCESS',
      description: `Referral bonus for friend referral #${referralId}`,
      createdByType: 'SYSTEM',
    });

    await qr.query(
      `UPDATE friend_referrals
          SET status = 'BONUS_CLEARING', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [referralId],
    );

    await qr.query(
      `INSERT INTO referral_status (user_id, total_referrals_converted, total_bonus_earned)
       VALUES ($1, 1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET total_referrals_converted = referral_status.total_referrals_converted + 1,
             total_bonus_earned = referral_status.total_bonus_earned + $2,
             updated_at = NOW()`,
      [referrerId, bonus],
    );

    this.logger.log(
      `Referral ${referralId} COMPLETED → BONUS_CLEARING: +${bonus} bonus to referrer ${referrerId} (wager ${wageringRequired} to clear)`,
    );
  }

  // ── Admin/maintenance: force a completion re-check ──
  //  For referrals whose targets are all met but were never credited because no
  //  deposit/bet event fired tryComplete — e.g. a 0-minimum rule, or rows fixed
  //  up by a config change/backfill. Runs the real tryComplete path (wallet
  //  credit + ledger + wagering record) in one transaction. Idempotent:
  //  already-credited (BONUS_CLEARING/DONE/COMPLETED) rows are left untouched.
  async recompute(
    referralId?: number,
  ): Promise<{ checked: number; credited: number[] }> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const targets = referralId
        ? await qr.query(
            `SELECT id FROM friend_referrals
              WHERE id = $1 AND status IN ('PENDING','ACTIVE')`,
            [referralId],
          )
        : await qr.query(
            `SELECT id FROM friend_referrals WHERE status IN ('PENDING','ACTIVE')`,
          );

      const credited: number[] = [];
      for (const t of targets) {
        const id = Number(t.id);
        const [before] = await qr.query(
          `SELECT status FROM friend_referrals WHERE id = $1`,
          [id],
        );
        await this.tryComplete(qr, id);
        const [after] = await qr.query(
          `SELECT status FROM friend_referrals WHERE id = $1`,
          [id],
        );
        if (
          before?.status !== after?.status &&
          ['BONUS_CLEARING', 'COMPLETED'].includes(after?.status)
        ) {
          credited.push(id);
        }
      }

      await qr.commitTransaction();
      this.logger.log(
        `recompute(${referralId ?? 'all'}): checked ${targets.length}, credited [${credited.join(',')}]`,
      );
      return { checked: targets.length, credited };
    } catch (e: any) {
      await qr.rollbackTransaction();
      this.logger.error(`recompute failed: ${e?.message}`);
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ── Expiry sweep: PENDING/ACTIVE past their window → EXPIRED ──
  @Cron('*/15 * * * *')
  async expireOverdue(): Promise<void> {
    try {
      await this.dataSource.query(
        `UPDATE friend_referrals
            SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
          WHERE status IN ('PENDING','ACTIVE') AND expires_at <= NOW()`,
      );
    } catch (e: any) {
      this.logger.warn(`Referral expiry sweep failed: ${e?.message}`);
    }
  }

  // Run `work` inside a SAVEPOINT so any failure rolls back ONLY the referral
  // changes, never the host (deposit/bet) transaction.
  private async isolated(
    qr: QueryRunner,
    name: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await qr.query(`SAVEPOINT ${name}`);
      await work();
      await qr.query(`RELEASE SAVEPOINT ${name}`);
    } catch (e: any) {
      await qr.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined);
      this.logger.warn(`Referral hook (${name}) failed; isolated & skipped: ${e?.message}`);
    }
  }
}
