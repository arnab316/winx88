-- =============================================================================
-- OroPlay integration tables
-- Run this against your Postgres DB before deploying the OroplayModule.
-- =============================================================================

-- 1. Flag on users table so we don't repeatedly call POST /user/create.
--    Note: unlike Palace, OroPlay's userCode IS our username — no mapping
--    table needed, since we already know the userCode for any local user.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS oroplay_registered BOOLEAN DEFAULT FALSE;

-- 2. Every bet / win / cancel from OroPlay lands here.
--    The UNIQUE constraint on transaction_code is the foundation of our
--    idempotency guarantee — OroPlay retries failed callbacks, and the
--    error code DUPLICATE_TRANSACTION (=6) tells them not to retry again.
CREATE TABLE IF NOT EXISTS oroplay_transactions (
  id                   BIGSERIAL      PRIMARY KEY,
  transaction_code     VARCHAR(255)   UNIQUE NOT NULL,
  history_id           VARCHAR(100),
  round_id             VARCHAR(255),
  user_id              INTEGER        NOT NULL REFERENCES users(id),
  vendor_code          VARCHAR(100),
  game_code            VARCHAR(100),
  game_type            INTEGER,                -- 1: Casino, 2: Slot, 3: Other, 4: Fishing
  amount               NUMERIC(15,2)  NOT NULL,  -- negative=bet, positive=win
  is_finished          BOOLEAN        DEFAULT FALSE,
  is_canceled          BOOLEAN        DEFAULT FALSE,
  balance_after        NUMERIC(15,2)  NOT NULL,
  detail               TEXT,
  created_at_provider  TIMESTAMP,
  created_at           TIMESTAMP      DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oroplay_tx_user    ON oroplay_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_oroplay_tx_round   ON oroplay_transactions(round_id);
CREATE INDEX IF NOT EXISTS idx_oroplay_tx_vendor  ON oroplay_transactions(vendor_code);
CREATE INDEX IF NOT EXISTS idx_oroplay_tx_created ON oroplay_transactions(created_at);

-- 3. Optional but useful: query "find finished rounds quickly" for the
--    INVALID_TRANSACTION check in callback service.
CREATE INDEX IF NOT EXISTS idx_oroplay_tx_round_finished
  ON oroplay_transactions(round_id)
  WHERE is_finished = TRUE;
