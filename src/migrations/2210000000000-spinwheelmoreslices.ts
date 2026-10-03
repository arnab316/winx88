import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen the spin wheel from 4/6 slices to 4/6/8/10/12.
 *
 * Migration 2200000000000 pinned both the wheel size and the slice position to
 * a 6-slice maximum:
 *
 *   spin_wheels_segment_count_check    CHECK (segment_count IN (4, 6))
 *   spin_segments_position_check       CHECK (position BETWEEN 0 AND 5)
 *
 * so an 8-slice wheel was rejected twice over — by the DTO (`position must not
 * be greater than 5`) and, had it got past that, by the database.
 *
 * Only the BOUNDS move. `SpinService.assertSegments` already validates against
 * the wheel's own `segment_count`, so a 6-slice wheel still rejects position 6
 * exactly as before; nothing here loosens the per-wheel rule.
 *
 * Even counts only: an odd number of slices leaves the pointer sitting on a
 * slice edge at the 12 o'clock rest position on most wheel renderers.
 */
export class SpinWheelMoreSlices2210000000000 implements MigrationInterface {
  name = 'SpinWheelMoreSlices2210000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.spin_wheels
        DROP CONSTRAINT IF EXISTS spin_wheels_segment_count_check;
    `);
    await q.query(`
      ALTER TABLE public.spin_wheels
        ADD CONSTRAINT spin_wheels_segment_count_check
        CHECK (segment_count IN (4, 6, 8, 10, 12));
    `);

    await q.query(`
      ALTER TABLE public.spin_wheel_segments
        DROP CONSTRAINT IF EXISTS spin_segments_position_check;
    `);
    await q.query(`
      ALTER TABLE public.spin_wheel_segments
        ADD CONSTRAINT spin_segments_position_check
        CHECK (position BETWEEN 0 AND 11);
    `);
  }

  /**
   * Narrowing back to 4/6 DELIBERATELY fails if any wheel has outgrown it —
   * Postgres validates a new CHECK against existing rows. That is the correct
   * behaviour: shrink or delete those wheels first, because silently dropping
   * their extra slices would leave a wheel with holes in its position sequence
   * and `spin_results` rows pointing at segments that no longer exist.
   */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE public.spin_wheel_segments
        DROP CONSTRAINT IF EXISTS spin_segments_position_check;
    `);
    await q.query(`
      ALTER TABLE public.spin_wheel_segments
        ADD CONSTRAINT spin_segments_position_check
        CHECK (position BETWEEN 0 AND 5);
    `);

    await q.query(`
      ALTER TABLE public.spin_wheels
        DROP CONSTRAINT IF EXISTS spin_wheels_segment_count_check;
    `);
    await q.query(`
      ALTER TABLE public.spin_wheels
        ADD CONSTRAINT spin_wheels_segment_count_check
        CHECK (segment_count IN (4, 6));
    `);
  }
}
