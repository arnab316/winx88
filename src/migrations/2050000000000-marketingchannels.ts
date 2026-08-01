import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MARKETING CHANNEL TRACKING (third-party media buyers).
 *
 * An agency buying ads on our behalf needs per-campaign tracking links and a
 * self-service report of clicks / registrations / FTDs / deposits. They get a
 * scoped API key and nothing else — never DB or server access.
 *
 * This is deliberately SEPARATE from the affiliate system. An affiliate is a
 * person with a payout (revshare, commission, a portal login); a channel is
 * just a campaign label owned by a vendor, with no money attached. Bridging the
 * two would drag payout logic into ad reporting.
 *
 * Tables:
 *   marketing_vendors          the buying agency
 *   marketing_vendor_api_keys  scoped read keys; only the sha256 hash is stored
 *   marketing_channels         one row per campaign, pre-registered by an admin
 *   marketing_clicks           raw link hits, logged even for unknown codes
 *   user_channel_attribution   which channel a registered user came from
 *
 * TWO RULES the schema enforces on purpose:
 *
 *  1. NEVER LOSE A PAID CLICK. A code that matches no channel is still inserted,
 *     with is_unknown = true and channel_id NULL. A typo in a campaign setup
 *     must show up in the unknown feed, not vanish. Note that registering the
 *     channel later does NOT retro-link those rows.
 *
 *  2. FIRST TOUCH WINS. user_channel_attribution is keyed on user_id, so the
 *     insert is ON CONFLICT DO NOTHING — a later visit through a different
 *     channel can never rewrite where a player originally came from, which is
 *     what makes the numbers defensible in a billing dispute.
 *
 * vendor_id is snapshotted (no FK) on clicks and attribution: reassigning a
 * channel to a different vendor must not silently rewrite historical numbers
 * that have already been invoiced.
 *
 * The partial index on deposits supports the FTD lookup (first APPROVED deposit
 * per user) that every vendor report runs — deposits had no index for it.
 *
 * Idempotent.
 */
export class MarketingChannels2050000000000 implements MigrationInterface {
  name = 'MarketingChannels2050000000000';

  public async up(q: QueryRunner): Promise<void> {
    // ── The buying agency ──
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.marketing_vendors (
        id            BIGSERIAL PRIMARY KEY,
        name          VARCHAR(120) NOT NULL,
        contact_email VARCHAR(160),
        status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','SUSPENDED')),
        notes         TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ── Scoped read keys. The plaintext secret is shown once at issuance and
    //    never stored; only sha256(secret) lives here. Revocation is a status
    //    flip, not a delete, so the audit trail survives.
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.marketing_vendor_api_keys (
        id                  BIGSERIAL PRIMARY KEY,
        vendor_id           BIGINT NOT NULL
                              REFERENCES public.marketing_vendors(id) ON DELETE CASCADE,
        key_prefix          VARCHAR(16) NOT NULL UNIQUE,
        key_hash            CHAR(64) NOT NULL,
        label               VARCHAR(80),
        status              VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                              CHECK (status IN ('ACTIVE','REVOKED')),
        expires_at          TIMESTAMPTZ,
        last_used_at        TIMESTAMPTZ,
        created_by_admin_id INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at          TIMESTAMPTZ
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_mvak_vendor
        ON public.marketing_vendor_api_keys (vendor_id)
        WHERE status = 'ACTIVE';
    `);

    // ── One row per campaign. `code` is what appears in the tracking URL. ──
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.marketing_channels (
        id                  BIGSERIAL PRIMARY KEY,
        code                VARCHAR(64) NOT NULL UNIQUE,
        vendor_id           BIGINT REFERENCES public.marketing_vendors(id) ON DELETE SET NULL,
        name                VARCHAR(120) NOT NULL,
        platform            VARCHAR(40),
        landing_path        VARCHAR(255) NOT NULL DEFAULT '/register',
        is_active           BOOLEAN NOT NULL DEFAULT true,
        created_by_admin_id INTEGER,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_marketing_channels_vendor
        ON public.marketing_channels (vendor_id);
    `);

    // ── Raw link hits. channel_code is stored AS SEEN so an unrecognised code
    //    is still auditable; click_uid is handed to the browser and echoed back
    //    at registration to tie a signup to its originating click.
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.marketing_clicks (
        id           BIGSERIAL PRIMARY KEY,
        click_uid    VARCHAR(36) NOT NULL UNIQUE,
        channel_code VARCHAR(64) NOT NULL,
        channel_id   BIGINT REFERENCES public.marketing_channels(id) ON DELETE SET NULL,
        vendor_id    BIGINT,
        is_unknown   BOOLEAN NOT NULL DEFAULT false,
        sub_id       VARCHAR(80),
        ip           VARCHAR(64),
        user_agent   TEXT,
        referer      TEXT,
        landing_path VARCHAR(255),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_marketing_clicks_channel_created
        ON public.marketing_clicks (channel_id, created_at);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_marketing_clicks_code_created
        ON public.marketing_clicks (channel_code, created_at);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_marketing_clicks_unknown
        ON public.marketing_clicks (created_at)
        WHERE is_unknown = true;
    `);

    // ── Which channel a registered player came from. PK on user_id is what
    //    makes first-touch-wins enforceable at the database level.
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.user_channel_attribution (
        user_id       BIGINT PRIMARY KEY,
        channel_code  VARCHAR(64) NOT NULL,
        channel_id    BIGINT REFERENCES public.marketing_channels(id) ON DELETE SET NULL,
        vendor_id     BIGINT,
        click_id      BIGINT REFERENCES public.marketing_clicks(id) ON DELETE SET NULL,
        is_unknown    BOOLEAN NOT NULL DEFAULT false,
        source        VARCHAR(20) NOT NULL DEFAULT 'PARAM'
                        CHECK (source IN ('REDIRECT','PARAM')),
        attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_uca_channel_attributed
        ON public.user_channel_attribution (channel_id, attributed_at);
    `);
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_uca_vendor
        ON public.user_channel_attribution (vendor_id);
    `);

    // ── FTD support. Every vendor report asks for the first APPROVED deposit
    //    per attributed user; deposits only had (user_id) and (status) alone.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_deposits_user_decided_approved
        ON public.deposits (user_id, decided_at)
        WHERE status = 'APPROVED';
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_deposits_user_decided_approved;`);
    await q.query(`DROP TABLE IF EXISTS public.user_channel_attribution;`);
    await q.query(`DROP TABLE IF EXISTS public.marketing_clicks;`);
    await q.query(`DROP TABLE IF EXISTS public.marketing_channels;`);
    await q.query(`DROP TABLE IF EXISTS public.marketing_vendor_api_keys;`);
    await q.query(`DROP TABLE IF EXISTS public.marketing_vendors;`);
  }
}
