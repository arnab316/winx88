-- ============================================================================
-- Palace Casino integration tables
-- Run this against your Postgres DB before deploying the PalaceCasinoModule.
-- ============================================================================

-- 1. Maps your internal users to Palace's user_code
CREATE TABLE IF NOT EXISTS palace_user_mapping (
  user_id           INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  palace_user_code  BIGINT      UNIQUE NOT NULL,
  created_at        TIMESTAMP   DEFAULT NOW()
);

-- 2. Every bet / win / cancel from Palace lands here.
--    The UNIQUE constraint on trans_guid is the foundation of our idempotency
--    guarantee — if Palace retries the same transaction we'll catch it.
CREATE TABLE IF NOT EXISTS slot_transactions (
  id              BIGSERIAL      PRIMARY KEY,
  trans_guid      VARCHAR(255)   UNIQUE NOT NULL,
  user_id         INTEGER        NOT NULL REFERENCES users(id),
  round_id        VARCHAR(255),
  game_code       VARCHAR(100),
  type            VARCHAR(20)    NOT NULL CHECK (type IN ('bet', 'win', 'cancel')),
  amount          NUMERIC(15,2)  NOT NULL,
  balance_after   NUMERIC(15,2)  NOT NULL,
  is_cancelled    BOOLEAN        DEFAULT FALSE,
  created_at      TIMESTAMP      DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slot_tx_user    ON slot_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_slot_tx_round   ON slot_transactions(round_id);
CREATE INDEX IF NOT EXISTS idx_slot_tx_created ON slot_transactions(created_at);

-- 3. Make sure wallets has a balance column with the right type.
--    (Skip if it already does — most Postgres deployments do.)
-- ALTER TABLE wallets ALTER COLUMN balance TYPE NUMERIC(15,2);
