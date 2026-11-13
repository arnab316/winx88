import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Address books uploaded from the Android app.
 *
 * The app asks for READ_CONTACTS and, once granted, sends the player's whole
 * contact list here. Two tables, because they answer different questions and
 * have different lifetimes:
 *
 *   device_contacts       the contacts themselves, one row per
 *                         (uploader, phone number).
 *   device_contact_syncs  one row per upload: who, when, from which device,
 *                         how many. This is the consent receipt. When someone
 *                         asks "why do you have my number", or a regulator
 *                         asks on their behalf, this table is the only thing
 *                         that can answer it — device_contacts alone cannot
 *                         say when or from what the data arrived.
 *
 * Note what is stored here: phone numbers of people who are NOT users of this
 * platform and who never agreed to anything. Only the uploader consented, and
 * they cannot consent on their contacts' behalf. That makes two columns load-
 * bearing for anything you do later:
 *
 *   matched_user_id   the contact is an existing player (resolved on digits,
 *                     see src/common/phone.util.ts). Non-NULL means the person
 *                     has their own relationship with the platform.
 *                     NULL means they do not — a stranger.
 *
 *   phone_normalized  the digits-only form, which is what makes the UNIQUE
 *                     constraint and the match actually work. `+880 17…`,
 *                     `017…` and `880 17…` are one number; comparing the raw
 *                     strings would store the same person three times and
 *                     match none of them.
 *
 * phone_raw keeps what the device had, because that is the only lossless copy
 * and normalisation makes assumptions about country codes.
 *
 * Idempotent.
 */
export class DeviceContacts2400000000000 implements MigrationInterface {
  name = 'DeviceContacts2400000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE IF NOT EXISTS public.device_contacts (
        id               BIGSERIAL     PRIMARY KEY,
        -- The player who uploaded, NOT the person in the contact.
        user_id          BIGINT        NOT NULL,
        display_name     VARCHAR(200),
        -- Exactly as the device stored it.
        phone_raw        VARCHAR(64)   NOT NULL,
        -- Digits-only, via normalizePhone(). Everything joins on this.
        phone_normalized VARCHAR(32)   NOT NULL,
        -- An existing player with this number, resolved at upload time.
        matched_user_id  BIGINT,
        first_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        last_seen_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT device_contacts_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE,
        -- SET NULL, not CASCADE: deleting a player must not delete somebody
        -- else's contact row, it just stops being a match.
        CONSTRAINT device_contacts_matched_fk FOREIGN KEY (matched_user_id)
          REFERENCES public.users(id) ON DELETE SET NULL
      );
    `);

    // Re-uploading the same address book must update, not duplicate. This is
    // what the ON CONFLICT in the sync endpoint targets.
    await q.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_device_contacts_user_phone
        ON public.device_contacts (user_id, phone_normalized);
    `);

    // "Who has this number in their contacts?" — the reverse lookup.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_device_contacts_phone
        ON public.device_contacts (phone_normalized);
    `);

    // "Which of my contacts already play?" — only the matched ones.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_device_contacts_matched
        ON public.device_contacts (matched_user_id)
        WHERE matched_user_id IS NOT NULL;
    `);

    await q.query(`
      CREATE TABLE IF NOT EXISTS public.device_contact_syncs (
        id              BIGSERIAL    PRIMARY KEY,
        user_id         BIGINT       NOT NULL,
        platform        VARCHAR(20),
        device_model    VARCHAR(120),
        app_version     VARCHAR(40),
        -- Sent by the client vs. actually stored: they differ when numbers
        -- are unparseable or duplicate within the book itself.
        received_count  INTEGER      NOT NULL DEFAULT 0,
        stored_count    INTEGER      NOT NULL DEFAULT 0,
        matched_count   INTEGER      NOT NULL DEFAULT 0,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT device_contact_syncs_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE
      );
    `);

    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_device_contact_syncs_user
        ON public.device_contact_syncs (user_id, created_at DESC);
    `);

    // Matching a contact to a player compares DIGITS, because the stored
    // phone keeps whatever the player typed (see phone.util.ts: the stored
    // string is never rewritten, since login matches it verbatim). Without
    // this functional index that comparison cannot use an index at all, and
    // every uploaded batch becomes a full scan of user_phone_numbers.
    //
    // Deliberately NOT unique: production still holds duplicate numbers
    // (the unique constraint from migration 2030000000000 was skipped there
    // pending a cleanup), and a unique index would fail to build.
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_user_phone_numbers_digits
        ON public.user_phone_numbers ((regexp_replace(phone_number, '\D', '', 'g')));
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS public.idx_user_phone_numbers_digits;`);
    await q.query(`DROP TABLE IF EXISTS public.device_contact_syncs;`);
    await q.query(`DROP TABLE IF EXISTS public.device_contacts;`);
  }
}
