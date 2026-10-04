import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * NOTIFICATIONS — phase 1: the spine and the in-app inbox.
 *
 * Four tables:
 *
 *   notification_templates    one row per event type — the catalogue
 *   notification_outbox       intent to notify, written inside the caller's txn
 *   notifications             the player's inbox (what the bell icon reads)
 *   notification_preferences  per-user, per-category consent
 *
 * The outbox is the load-bearing idea. Events fire inside database
 * transactions (decideDeposit, decideWithdrawal, settleRound). Enqueue INSIDE
 * the transaction and a rollback leaves you announcing a deposit that never
 * happened; enqueue AFTER commit and a crash in the gap loses it silently.
 * Writing the outbox row in the same transaction removes the gap entirely —
 * money and intent-to-notify commit or vanish together, and a relay moves
 * committed rows onto the queue afterwards.
 *
 * The catalogue lives in the database, not in code, so adding a notification
 * type later is an INSERT plus one emitted event rather than a deploy.
 *
 * Idempotent.
 */
export class Notifications2230000000000 implements MigrationInterface {
  name = 'Notifications2230000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── the catalogue ────────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.notification_templates (
        id            BIGSERIAL    PRIMARY KEY,

        -- Stable machine name emitted by the app, e.g. DEPOSIT_APPROVED.
        event_key     VARCHAR(64)  NOT NULL UNIQUE,

        -- TRANSACTIONAL is never suppressed by preferences; MARKETING always is.
        category      VARCHAR(24)  NOT NULL DEFAULT 'TRANSACTIONAL',

        -- Which channels this event goes out on. Phase 1 ships IN_APP + SOCKET;
        -- PUSH/SMS/EMAIL are accepted now so adding them later is data, not DDL.
        channels      TEXT[]       NOT NULL DEFAULT '{IN_APP,SOCKET}',

        -- {{placeholder}} bodies, rendered per notification.
        title_en      VARCHAR(200) NOT NULL,
        body_en       TEXT         NOT NULL,
        title_bn      VARCHAR(200),
        body_bn       TEXT,

        -- Where tapping it should take the player, e.g. /wallet/deposits.
        deep_link     VARCHAR(200),
        icon          VARCHAR(64),

        is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT notif_templates_category_check
          CHECK (category IN ('TRANSACTIONAL','GAMEPLAY','PROMOTIONAL','SECURITY'))
      );
    `);

    // ── intent to notify ─────────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.notification_outbox (
        id               BIGSERIAL    PRIMARY KEY,

        event_key        VARCHAR(64)  NOT NULL,
        user_id          BIGINT       REFERENCES public.users(id) ON DELETE CASCADE,

        -- Values for the template's {{placeholders}}, plus anything a channel
        -- needs at send time.
        payload          JSONB        NOT NULL DEFAULT '{}'::jsonb,

        -- The relay can hand the same row to the queue twice after a crash, and
        -- a caller can retry. A unique key makes the second attempt a no-op
        -- instead of a second buzz in the player's pocket.
        idempotency_key  VARCHAR(160) UNIQUE,

        status           VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
        attempts         SMALLINT     NOT NULL DEFAULT 0,
        last_error       TEXT,

        available_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        queued_at        TIMESTAMPTZ,
        processed_at     TIMESTAMPTZ,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT notif_outbox_status_check
          CHECK (status IN ('PENDING','QUEUED','SENT','FAILED','SKIPPED'))
      );
    `);

    // The relay's only query: oldest due PENDING rows first.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_notif_outbox_due
        ON public.notification_outbox (available_at, id)
        WHERE status = 'PENDING';
    `);

    // ── the player's inbox ───────────────────────────────────────
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.notifications (
        id             BIGSERIAL    PRIMARY KEY,
        user_id        BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

        event_key      VARCHAR(64)  NOT NULL,
        category       VARCHAR(24)  NOT NULL DEFAULT 'TRANSACTIONAL',

        -- Rendered at send time and stored. The template can be reworded
        -- tomorrow; what the player was told must not change with it.
        title          VARCHAR(200) NOT NULL,
        body           TEXT         NOT NULL,
        locale         VARCHAR(5)   NOT NULL DEFAULT 'en',
        deep_link      VARCHAR(200),
        icon           VARCHAR(64),
        data           JSONB        NOT NULL DEFAULT '{}'::jsonb,

        outbox_id      BIGINT,
        -- delivered = the client acknowledged the socket frame; read = the
        -- player actually opened it. Both nullable, both meaningful.
        delivered_at   TIMESTAMPTZ,
        read_at        TIMESTAMPTZ,
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT notif_category_check
          CHECK (category IN ('TRANSACTIONAL','GAMEPLAY','PROMOTIONAL','SECURITY'))
      );
    `);

    // Feeds both the inbox list and the catch-up fetch (id > sinceId).
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_user
        ON public.notifications (user_id, id DESC);
    `);
    // Unread badge count.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_unread
        ON public.notifications (user_id)
        WHERE read_at IS NULL;
    `);

    // ── consent ──────────────────────────────────────────────────
    // A missing row means "default": transactional on, promotional off. That
    // way a player who has never touched settings is opted OUT of marketing,
    // which is the position most gambling regulators expect.
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.notification_preferences (
        user_id     BIGINT       NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
        category    VARCHAR(24)  NOT NULL,
        channel     VARCHAR(16)  NOT NULL,
        enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        PRIMARY KEY (user_id, category, channel),
        CONSTRAINT notif_pref_category_check
          CHECK (category IN ('TRANSACTIONAL','GAMEPLAY','PROMOTIONAL','SECURITY')),
        CONSTRAINT notif_pref_channel_check
          CHECK (channel IN ('IN_APP','SOCKET','PUSH','SMS','EMAIL'))
      );
    `);

    // ── seed the phase-1 catalogue ───────────────────────────────
    await q.query(`
      INSERT INTO public.notification_templates
        (event_key, category, channels, title_en, body_en, title_bn, body_bn, deep_link, icon)
      VALUES
        ('DEPOSIT_APPROVED', 'TRANSACTIONAL', '{IN_APP,SOCKET}',
         'Deposit successful',
         'Your deposit of {{amount}} has been added to your balance.',
         'ডিপোজিট সফল',
         'আপনার {{amount}} ডিপোজিট ব্যালেন্সে যোগ হয়েছে।',
         '/wallet/deposits', 'deposit'),

        ('DEPOSIT_REJECTED', 'TRANSACTIONAL', '{IN_APP,SOCKET}',
         'Deposit declined',
         'Your deposit of {{amount}} could not be approved. {{reason}}',
         'ডিপোজিট বাতিল',
         'আপনার {{amount}} ডিপোজিট অনুমোদন করা যায়নি। {{reason}}',
         '/wallet/deposits', 'alert'),

        ('WITHDRAWAL_APPROVED', 'TRANSACTIONAL', '{IN_APP,SOCKET}',
         'Withdrawal sent',
         'Your withdrawal of {{amount}} is on its way.',
         'উইথড্র সম্পন্ন',
         'আপনার {{amount}} উইথড্র পাঠানো হয়েছে।',
         '/wallet/withdrawals', 'withdrawal'),

        ('WITHDRAWAL_REJECTED', 'TRANSACTIONAL', '{IN_APP,SOCKET}',
         'Withdrawal declined',
         'Your withdrawal of {{amount}} was declined. {{reason}}',
         'উইথড্র বাতিল',
         'আপনার {{amount}} উইথড্র বাতিল হয়েছে। {{reason}}',
         '/wallet/withdrawals', 'alert'),

        ('ACCOUNT_SUSPENDED', 'SECURITY', '{IN_APP,SOCKET}',
         'Account {{status}}',
         'Your account is {{status}}. Deposits, withdrawals and betting are paused. Contact support.',
         'অ্যাকাউন্ট {{status}}',
         'আপনার অ্যাকাউন্ট {{status}}। ডিপোজিট, উইথড্র ও বাজি বন্ধ আছে। সাপোর্টে যোগাযোগ করুন।',
         '/support', 'security'),

        ('ADMIN_BROADCAST', 'PROMOTIONAL', '{IN_APP,SOCKET}',
         '{{title}}', '{{body}}', '{{title}}', '{{body}}',
         NULL, 'megaphone')
      ON CONFLICT (event_key) DO NOTHING;
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS public.notification_preferences;`);
    await q.query(`DROP TABLE IF EXISTS public.notifications;`);
    await q.query(`DROP TABLE IF EXISTS public.notification_outbox;`);
    await q.query(`DROP TABLE IF EXISTS public.notification_templates;`);
  }
}
