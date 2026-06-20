import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refer-a-friend referral system — the ৳500 friend bonus with a 7-day window.
 *
 * SEPARATE from the existing affiliate / RevShare system (affiliate_users) AND
 * from the existing `referrals` table (which the affiliate layer already owns),
 * so the main table here is `friend_referrals` to avoid the name collision.
 * It reuses users.referral_code (invite code) and users.referred_by_user_id.
 *
 *   referral_config         — tunable rules (bonus, multiplier, minimums, window)
 *   friend_referrals        — one row per (referrer, referee) pair + progress/status
 *   referral_bonus_wagering — the ৳500 bonus wagering tracker, one per referral
 *   referral_status         — per-user lifetime aggregates + one-time turnover unlock
 *
 * Idempotent so it is safe to (re)apply.
 */
export class ReferralSystem1800000000002 implements MigrationInterface {
  name = 'ReferralSystem1800000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. referral_config: key/value tunables (rules are never hardcoded) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.referral_config (
        id            SERIAL PRIMARY KEY,
        config_key    VARCHAR(100) NOT NULL UNIQUE,
        config_value  TEXT NOT NULL,
        description   TEXT,
        updated_by    BIGINT REFERENCES public.users(id),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await queryRunner.query(`
      INSERT INTO public.referral_config (config_key, config_value, description) VALUES
        ('bonus_amount',          '500',  'Bonus credited to referrer in BDT'),
        ('wagering_multiplier',   '10',   'Bonus wagering requirement multiplier (10 = 10x)'),
        ('referrer_deposit_min',  '1000', 'Minimum deposit required from referrer in BDT'),
        ('referee_deposit_min',   '1000', 'Minimum deposit required from referee in BDT'),
        ('referrer_turnover_min', '2250', 'Referrer turnover target in BDT (first-time only)'),
        ('referee_turnover_min',  '4500', 'Referee turnover target in BDT'),
        ('window_hours',          '168',  'Referral validity window in hours')
      ON CONFLICT (config_key) DO NOTHING;
    `);

    // ── 2. friend_referrals: one row per (referrer, referee) pair ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.friend_referrals (
        id                        BIGSERIAL PRIMARY KEY,
        referrer_user_id          BIGINT NOT NULL REFERENCES public.users(id),
        referee_user_id           BIGINT NOT NULL REFERENCES public.users(id),

        started_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at                TIMESTAMPTZ NOT NULL,
        completed_at              TIMESTAMPTZ,
        expired_at                TIMESTAMPTZ,

        referrer_deposit_total    NUMERIC(15,2) DEFAULT 0,
        referee_deposit_total     NUMERIC(15,2) DEFAULT 0,
        referrer_deposit_met      BOOLEAN DEFAULT FALSE,
        referee_deposit_met       BOOLEAN DEFAULT FALSE,

        referrer_turnover_total   NUMERIC(15,2) DEFAULT 0,
        referee_turnover_total    NUMERIC(15,2) DEFAULT 0,
        referrer_turnover_met     BOOLEAN DEFAULT FALSE,
        referee_turnover_met      BOOLEAN DEFAULT FALSE,

        -- snapshot of the referrer's lifetime unlock at creation time
        referrer_was_unlocked     BOOLEAN DEFAULT FALSE,

        -- config snapshot so later rule changes never rewrite history
        config_bonus_amount       NUMERIC(10,2) NOT NULL,
        config_wagering_mult      SMALLINT NOT NULL,
        config_referrer_dep_min   NUMERIC(10,2) NOT NULL,
        config_referee_dep_min    NUMERIC(10,2) NOT NULL,
        config_referrer_turn_min  NUMERIC(10,2) NOT NULL,
        config_referee_turn_min   NUMERIC(10,2) NOT NULL,
        config_window_hours       SMALLINT NOT NULL,

        status                    VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                                    CHECK (status IN ('PENDING','ACTIVE','COMPLETED','EXPIRED','DISQUALIFIED','BONUS_CLEARING','DONE')),
        disqualification_reason   TEXT,

        created_at                TIMESTAMPTZ DEFAULT NOW(),
        updated_at                TIMESTAMPTZ DEFAULT NOW(),

        CONSTRAINT friend_referrals_unique_pair     UNIQUE (referrer_user_id, referee_user_id),
        -- a user can be the referee in at most ONE referral, ever (doc §12)
        CONSTRAINT friend_referrals_one_per_referee UNIQUE (referee_user_id),
        -- you cannot refer yourself
        CONSTRAINT friend_referrals_no_self CHECK (referrer_user_id <> referee_user_id)
      );
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_friend_referrals_referrer   ON public.friend_referrals(referrer_user_id);`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_friend_referrals_referee    ON public.friend_referrals(referee_user_id);`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_friend_referrals_status     ON public.friend_referrals(status);`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_friend_referrals_expires_at ON public.friend_referrals(expires_at);`);

    // ── 3. referral_bonus_wagering: bonus wagering tracker (one per referral) ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.referral_bonus_wagering (
        id                  BIGSERIAL PRIMARY KEY,
        referral_id         BIGINT NOT NULL REFERENCES public.friend_referrals(id) ON DELETE CASCADE,
        referrer_user_id    BIGINT NOT NULL REFERENCES public.users(id),
        bonus_amount        NUMERIC(10,2) NOT NULL,
        wagering_required   NUMERIC(15,2) NOT NULL,
        wagering_completed  NUMERIC(15,2) DEFAULT 0,
        is_cleared          BOOLEAN DEFAULT FALSE,
        cleared_at          TIMESTAMPTZ,
        bonus_credited_at   TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT rbw_one_per_referral UNIQUE (referral_id)
      );
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_rbw_referrer ON public.referral_bonus_wagering(referrer_user_id);`);

    // ── 4. referral_status: per-user lifetime unlock + aggregates ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.referral_status (
        user_id                       BIGINT PRIMARY KEY REFERENCES public.users(id),
        referrer_turnover_unlocked    BOOLEAN DEFAULT FALSE,
        referrer_turnover_unlocked_at TIMESTAMPTZ,
        total_referrals_sent          INT DEFAULT 0,
        total_referrals_converted     INT DEFAULT 0,
        total_bonus_earned            NUMERIC(15,2) DEFAULT 0,
        created_at                    TIMESTAMPTZ DEFAULT NOW(),
        updated_at                    TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Resolve referrer by invite code at registration (idempotent — may already exist).
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_users_referral_code ON public.users(referral_code);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS public.referral_bonus_wagering;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.referral_status;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.friend_referrals;`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.referral_config;`);
  }
}
