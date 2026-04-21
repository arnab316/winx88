import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAgents1680000000000 implements MigrationInterface {
  name = 'CreateAgents1680000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── Agents table ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.agents (
        id                  BIGSERIAL PRIMARY KEY,
        gateway_id          BIGINT        NOT NULL,
        wallet_type         VARCHAR(30)   NOT NULL,
        agent_number        VARCHAR(30)   NOT NULL,
        agent_code          VARCHAR(30),
        start_date          DATE,
        stop_date           DATE,
        status              VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
        assignment_count    BIGINT        NOT NULL DEFAULT 0,
        last_assigned_at    TIMESTAMPTZ,
        created_by_admin_id BIGINT,
        created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

        CONSTRAINT agents_status_check
          CHECK (status IN ('ACTIVE','INACTIVE')),
        CONSTRAINT agents_wallet_type_check
          CHECK (wallet_type IN ('bKash','Nagad','Rocket','Bank','Crypto')),
        CONSTRAINT agents_gateway_fk FOREIGN KEY (gateway_id)
          REFERENCES public.payment_gateways(id) ON DELETE RESTRICT,
        CONSTRAINT agents_unique_active_number
          UNIQUE (gateway_id, agent_number)
      );
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_agents_status ON public.agents(status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_agents_gateway_status ON public.agents(gateway_id, status);`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_agents_assignment_count ON public.agents(assignment_count);`,
    );

    // ─── Agent assignment history (audit trail) ───────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.agent_assignments (
        id          BIGSERIAL PRIMARY KEY,
        agent_id    BIGINT       NOT NULL,
        user_id     BIGINT       NOT NULL,
        gateway_id  BIGINT       NOT NULL,
        assigned_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

        CONSTRAINT agent_assignments_agent_fk FOREIGN KEY (agent_id)
          REFERENCES public.agents(id) ON DELETE CASCADE,
        CONSTRAINT agent_assignments_user_fk FOREIGN KEY (user_id)
          REFERENCES public.users(id) ON DELETE CASCADE
      );
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_agent_assign_user_time
       ON public.agent_assignments(user_id, assigned_at DESC);`,
    );

    // ─── Seed default payment gateways (idempotent) ───────────────
    // Requires a unique constraint on payment_gateways.name for ON CONFLICT
    // to work. If your table doesn't have one, this will just insert every
    // time — in that case, convert to a WHERE NOT EXISTS pattern (shown below).
    await queryRunner.query(`
      INSERT INTO public.payment_gateways (name, type, account_no, is_active)
      SELECT v.name, v.type, v.account_no, v.is_active
      FROM (VALUES
        ('bKash',  'MOBILE_BANKING', NULL::varchar, TRUE),
        ('Nagad',  'MOBILE_BANKING', NULL::varchar, TRUE),
        ('Rocket', 'MOBILE_BANKING', NULL::varchar, TRUE)
      ) AS v(name, type, account_no, is_active)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.payment_gateways pg WHERE pg.name = v.name
      );
    `);

    // ─── Link deposits to the agent used ──────────────────────────
    await queryRunner.query(
      `ALTER TABLE public.deposits
         ADD COLUMN IF NOT EXISTS agent_id BIGINT;`,
    );

    // Add FK only if it doesn't already exist (re-run safety)
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'deposits_agent_fk'
        ) THEN
          ALTER TABLE public.deposits
            ADD CONSTRAINT deposits_agent_fk
            FOREIGN KEY (agent_id)
            REFERENCES public.agents(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS idx_deposits_agent_id ON public.deposits(agent_id);`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order: drop FK → column on deposits, then child table, then parent
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_deposits_agent_id;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_agent_fk;`,
    );
    await queryRunner.query(
      `ALTER TABLE public.deposits DROP COLUMN IF EXISTS agent_id;`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_agent_assign_user_time;`,
    );
    await queryRunner.query(
      `DROP TABLE IF EXISTS public.agent_assignments;`,
    );

    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_agents_assignment_count;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_agents_gateway_status;`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS public.idx_agents_status;`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS public.agents;`);

    // NOTE: We intentionally do NOT delete the seeded payment_gateways rows
    // in down() — they may be referenced by other tables. Remove manually
    // if you truly need to.
  }
}