// src/spin/spin.service.ts
import {
  Injectable, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { randomInt } from 'crypto';

import { TurnoverService } from '../turnover/turnover.service';
import { MemberGroupService } from '../member-group/member-group.service';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import {
  CreateSpinWheelDto, UpdateSpinWheelDto, ReplaceSegmentsDto,
  ListSpinWheelsQueryDto, ListSpinResultsQueryDto, MySpinHistoryQueryDto,
  SpinSegmentDto, SpinNowDto,
} from './dto/spin.dto';

/** The window the schedule is currently in, in absolute time. */
interface SpinWindow {
  windowStart: Date;
  windowEnd: Date;
  nextWindowStart: Date;
}

/**
 * Resolves the current occurrence of a recurring schedule, in the wheel's own
 * timezone, entirely in Postgres.
 *
 * Doing the arithmetic in SQL rather than JS is deliberate: `AT TIME ZONE`
 * already knows about DST, so "every Friday 18:00 Asia/Dhaka" keeps meaning
 * 18:00 local across a clock change. Hand-rolling that from a UTC offset is
 * where scheduled-bonus bugs come from.
 *
 * `cand` is this period's occurrence; if it has not happened yet the player is
 * still inside the previous period, so we step back one period.
 */
const WINDOW_SQL = `
  WITH cfg AS (
    SELECT $1::text AS tz, $2::text AS freq, $3::int AS dow,
           $4::int AS dom, $5::time AS st, $6::int AS wmin
  ),
  loc AS (SELECT timezone(cfg.tz, now()) AS ln, cfg.* FROM cfg),
  base AS (
    SELECT ln, tz, wmin, freq,
      CASE freq
        WHEN 'DAILY'  THEN date_trunc('day', ln) + st
        WHEN 'WEEKLY' THEN date_trunc('week', ln)
                             + make_interval(days => ((COALESCE(dow, 0) + 6) % 7)) + st
        ELSE               date_trunc('month', ln)
                             + make_interval(days => (COALESCE(dom, 1) - 1)) + st
      END AS cand
    FROM loc
  ),
  adj AS (
    SELECT ln, tz, wmin, freq,
      CASE WHEN cand > ln THEN
        CASE freq
          WHEN 'DAILY'  THEN cand - interval '1 day'
          WHEN 'WEEKLY' THEN cand - interval '7 days'
          ELSE               cand - interval '1 month'
        END
      ELSE cand END AS ws
    FROM base
  )
  SELECT
    (ws AT TIME ZONE tz) AS window_start,
    ((ws + CASE WHEN wmin IS NULL THEN period ELSE make_interval(mins => wmin) END)
       AT TIME ZONE tz) AS window_end,
    ((ws + period) AT TIME ZONE tz) AS next_window_start
  FROM (
    SELECT adj.*,
      CASE freq
        WHEN 'DAILY'  THEN interval '1 day'
        WHEN 'WEEKLY' THEN interval '7 days'
        ELSE               interval '1 month'
      END AS period
    FROM adj
  ) x
`;

@Injectable()
export class SpinService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly turnoverService: TurnoverService,
    private readonly memberGroups: MemberGroupService,
    private readonly financialLedger: FinancialLedgerService,
  ) {}

  // ═══════════════════════════════════════════════════════════════
  // SCHEDULE
  // ═══════════════════════════════════════════════════════════════

  private async resolveWindow(
    runner: QueryRunner | DataSource,
    wheel: any,
  ): Promise<SpinWindow> {
    const [row] = await runner.query(WINDOW_SQL, [
      wheel.timezone ?? 'Asia/Dhaka',
      wheel.frequency ?? 'WEEKLY',
      wheel.day_of_week ?? null,
      wheel.day_of_month ?? null,
      wheel.start_time ?? '00:00',
      wheel.window_minutes ?? null,
    ]);

    return {
      windowStart: new Date(row.window_start),
      windowEnd: new Date(row.window_end),
      nextWindowStart: new Date(row.next_window_start),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PLAYER — what should the wheel look like right now
  // ═══════════════════════════════════════════════════════════════

  /**
   * The live wheel for this player, its slices, and whether they may spin.
   *
   * Never returns `weight`: the odds are house data, and a client that knows
   * them can tell the player exactly how rigged the wheel is.
   */
  async getStateForUser(userId: number | null, currency = 'BDT') {
    const wheel = await this.findLiveWheel(currency);
    if (!wheel) return null;

    const segments = await this.dataSource.query(
      `SELECT id, position, label, amount, turnover_multiplier, color, is_active
         FROM spin_wheel_segments
        WHERE wheel_id = $1
        ORDER BY position ASC`,
      [wheel.id],
    );

    const win = await this.resolveWindow(this.dataSource, wheel);
    const now = new Date();
    const windowOpen = now >= win.windowStart && now < win.windowEnd;

    let spinsUsed = 0;
    let eligibility: { ok: boolean; reason?: string } = { ok: true };

    if (userId) {
      spinsUsed = await this.countSpinsInWindow(this.dataSource, userId, wheel.id, win.windowStart);
      eligibility = await this.checkEligibility(this.dataSource, userId, wheel, win);
    }

    const spinsLeft = Math.max(0, Number(wheel.spins_per_window) - spinsUsed);

    return {
      wheelId: Number(wheel.id),
      name: wheel.name,
      currency: wheel.currency,
      segmentCount: Number(wheel.segment_count),
      // The prize list, in draw order. `position` is the index the client
      // animates the pointer to.
      segments: segments.map((s: any) => ({
        id: Number(s.id),
        position: Number(s.position),
        label: s.label,
        amount: parseFloat(s.amount),
        turnoverMultiplier: parseFloat(s.turnover_multiplier),
        color: s.color,
        isActive: s.is_active,
      })),
      schedule: {
        frequency: wheel.frequency,
        dayOfWeek: wheel.day_of_week === null ? null : Number(wheel.day_of_week),
        dayOfMonth: wheel.day_of_month === null ? null : Number(wheel.day_of_month),
        startTime: wheel.start_time,
        windowMinutes: wheel.window_minutes === null ? null : Number(wheel.window_minutes),
        timezone: wheel.timezone,
      },
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
      nextWindowStart: win.nextWindowStart,
      windowOpen,
      spinsPerWindow: Number(wheel.spins_per_window),
      spinsUsed,
      spinsLeft,
      // The single flag the button should read.
      canSpin: !!userId && windowOpen && spinsLeft > 0 && eligibility.ok,
      // Ordered by what the player most needs to know. Eligibility outranks the
      // quota deliberately: telling a suspended player they are "out of spins"
      // hides the actual problem behind a message that will never resolve.
      reason: !userId
        ? 'Log in to spin'
        : !eligibility.ok
          ? eligibility.reason ?? 'You are not eligible for this wheel'
          : !windowOpen
            ? 'The wheel is closed right now'
            : spinsLeft <= 0
              ? 'You have used your spins for this round'
              : null,
    };
  }

  private async findLiveWheel(currency: string) {
    const [wheel] = await this.dataSource.query(
      `SELECT * FROM spin_wheels
        WHERE is_active = TRUE
          AND currency = $1
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at   IS NULL OR ends_at   >  NOW())
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
      [currency],
    );
    return wheel ?? null;
  }

  private async countSpinsInWindow(
    runner: QueryRunner | DataSource,
    userId: number,
    wheelId: number,
    windowStart: Date,
  ): Promise<number> {
    const [row] = await runner.query(
      `SELECT COUNT(*)::int AS n
         FROM spin_results
        WHERE user_id = $1 AND wheel_id = $2 AND window_start = $3`,
      [userId, wheelId, windowStart],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * The three optional gates, in the order that gives the player the most
   * useful message. All unset = open to everyone.
   */
  private async checkEligibility(
    runner: QueryRunner | DataSource,
    userId: number,
    wheel: any,
    win: SpinWindow,
  ): Promise<{ ok: boolean; reason?: string }> {
    const [user] = await runner.query(
      `SELECT id, vip_level, account_status FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (!user) return { ok: false, reason: 'User not found' };
    if (user.account_status && user.account_status !== 'ACTIVE') {
      return { ok: false, reason: 'Your account is not active' };
    }

    const minVip = Number(wheel.min_vip_level ?? 0);
    if (minVip > 0 && Number(user.vip_level ?? 0) < minVip) {
      return { ok: false, reason: `This wheel is for VIP level ${minVip} and above` };
    }

    if (wheel.member_group_id) {
      const qr = runner instanceof DataSource ? null : (runner as QueryRunner);
      const inGroup = await this.memberGroups.isUserInGroup(
        qr, userId, Number(wheel.member_group_id),
      );
      if (!inGroup) return { ok: false, reason: 'This wheel is for a different member group' };
    }

    if (wheel.min_deposit_in_window != null) {
      const need = parseFloat(wheel.min_deposit_in_window);
      const [dep] = await runner.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
           FROM deposits
          WHERE user_id = $1
            AND status = 'APPROVED'
            AND created_at >= $2
            AND created_at <  $3`,
        [userId, win.windowStart, win.windowEnd],
      );
      const got = parseFloat(dep?.total ?? '0');
      if (got < need) {
        return {
          ok: false,
          reason: `Deposit ${need} during this round to unlock your spin (you have ${got})`,
        };
      }
    }

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════
  // PLAYER — the spin itself
  // ═══════════════════════════════════════════════════════════════

  /**
   * One spin, one transaction.
   *
   * The winning slice is drawn here and never accepted from the client. The
   * prize is credited on the same path a promotion bonus takes, and raises a
   * normal turnover requirement, so nothing downstream needs to know that a
   * wheel was involved.
   */
  async spin(
    userId: number,
    dto: SpinNowDto,
    ctx: { ipAddress?: string; deviceFingerprint?: string } = {},
  ) {
    const currency = dto.currency ?? 'BDT';

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      // ── 1. the wheel ──
      const [wheel] = dto.wheelId
        ? await qr.query(`SELECT * FROM spin_wheels WHERE id = $1 LIMIT 1`, [dto.wheelId])
        : await qr.query(
            `SELECT * FROM spin_wheels
              WHERE is_active = TRUE AND currency = $1
                AND (starts_at IS NULL OR starts_at <= NOW())
                AND (ends_at   IS NULL OR ends_at   >  NOW())
              ORDER BY updated_at DESC, id DESC
              LIMIT 1`,
            [currency],
          );

      if (!wheel) throw new NotFoundException('No spin wheel is running right now');
      if (!wheel.is_active) throw new BadRequestException('This wheel is not active');
      if (wheel.starts_at && new Date(wheel.starts_at) > new Date()) {
        throw new BadRequestException('This wheel has not started yet');
      }
      if (wheel.ends_at && new Date(wheel.ends_at) <= new Date()) {
        throw new BadRequestException('This wheel has ended');
      }

      // ── 2. the window ──
      const win = await this.resolveWindow(qr, wheel);
      const now = new Date();
      if (now < win.windowStart || now >= win.windowEnd) {
        throw new BadRequestException(
          `The wheel is closed. It opens again at ${win.nextWindowStart.toISOString()}`,
        );
      }

      // ── 3. may they? ──
      const elig = await this.checkEligibility(qr, userId, wheel, win);
      if (!elig.ok) throw new BadRequestException(elig.reason);

      const used = await this.countSpinsInWindow(qr, userId, wheel.id, win.windowStart);
      if (used >= Number(wheel.spins_per_window)) {
        throw new BadRequestException('You have already used your spins for this round');
      }

      // ── 4. draw ──
      const segments = await qr.query(
        `SELECT id, position, label, amount, turnover_multiplier, weight
           FROM spin_wheel_segments
          WHERE wheel_id = $1 AND is_active = TRUE
          ORDER BY position ASC`,
        [wheel.id],
      );
      if (segments.length !== Number(wheel.segment_count)) {
        throw new BadRequestException(
          `This wheel is misconfigured: ${segments.length} active slices for a ` +
          `${wheel.segment_count}-slice wheel. An admin needs to fix it.`,
        );
      }

      const won = this.drawSegment(segments);
      const prize = parseFloat(won.amount);
      const multiplier = parseFloat(won.turnover_multiplier ?? '0');

      // ── 5. record the spin FIRST ──
      // The unique constraint on (user, wheel, window, spin_index) is the real
      // quota check: two taps that both passed step 3 collide here, and the
      // loser rolls back before any money moves.
      let resultId: number;
      try {
        const inserted = await qr.query(
          `INSERT INTO spin_results
             (user_id, wheel_id, segment_id, segment_position, segment_label,
              amount, turnover_multiplier, turnover_target,
              window_start, window_end, spin_index, ip_address, device_fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [
            userId, wheel.id, won.id, won.position, won.label,
            prize, multiplier, this.round2(prize * multiplier),
            win.windowStart, win.windowEnd, used,
            ctx.ipAddress ?? null, ctx.deviceFingerprint ?? null,
          ],
        );
        resultId = Number(inserted[0].id);
      } catch (e: any) {
        if (e?.code === '23505') {
          throw new ConflictException('That spin was already counted');
        }
        throw e;
      }

      // ── 6. pay ──
      let turnoverRequirementId: number | null = null;
      let turnoverTarget = 0;

      if (prize > 0) {
        await this.creditPrize(qr, userId, prize, wheel.bonus_to, resultId, wheel.id);

        if (multiplier > 0) {
          const req = await this.turnoverService.insertRequirement(qr, {
            userId,
            sourceType: 'SPIN',
            sourceId: resultId,
            baseAmount: prize,
            multiplier,
            targetAmount: this.round2(prize * multiplier),
            label: `Spin wheel — ${won.label ?? `slice ${won.position}`}`,
          });
          turnoverRequirementId = req.requirementId;
          turnoverTarget = req.targetAmount;

          await qr.query(
            `UPDATE spin_results SET turnover_requirement_id = $1 WHERE id = $2`,
            [turnoverRequirementId, resultId],
          );
        }
      }

      await qr.commitTransaction();

      return {
        spinId: resultId,
        wheelId: Number(wheel.id),
        // What the client animates to.
        segmentPosition: Number(won.position),
        segmentId: Number(won.id),
        label: won.label,
        amount: prize,
        won: prize > 0,
        creditedTo: prize > 0 ? wheel.bonus_to : null,
        turnoverMultiplier: multiplier,
        turnoverTarget,
        turnoverRequirementId,
        spinsLeft: Math.max(0, Number(wheel.spins_per_window) - (used + 1)),
        nextWindowStart: win.nextWindowStart,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  /**
   * Weighted draw over the active slices.
   *
   * `randomInt` from node:crypto rather than `Math.random()` — this decides who
   * gets paid, so it should not come from a PRNG that is seeded predictably.
   */
  private drawSegment(segments: any[]) {
    const weights = segments.map((s) => Math.max(0, Number(s.weight ?? 1)));
    const total = weights.reduce((a, b) => a + b, 0);

    // Every weight set to 0 is a configuration mistake, not a reason to fail a
    // player's spin — fall back to an even wheel.
    if (total <= 0) return segments[randomInt(0, segments.length)];

    let ticket = randomInt(0, total);
    for (let i = 0; i < segments.length; i++) {
      ticket -= weights[i];
      if (ticket < 0) return segments[i];
    }
    return segments[segments.length - 1];
  }

  /**
   * Credit the prize.
   *
   * Mirrors PromotionEngineService.creditWallet: a BONUS_BALANCE prize is added
   * to `balance` so the player can actually play with it, and mirrored into
   * `bonus_balance` so admins and the withdrawal gate can see how much of the
   * balance is bonus money. It is written here rather than reused because the
   * engine's version hard-codes PROMOTION ledger types, and a spin should be
   * traceable as a spin.
   */
  private async creditPrize(
    qr: QueryRunner,
    userId: number,
    amount: number,
    destination: string,
    spinResultId: number,
    wheelId: number,
  ) {
    const wRows = await qr.query(
      `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    if (!wRows.length) throw new NotFoundException('Wallet not found');
    const w = wRows[0];

    const balBefore = parseFloat(w.balance);
    const bonBefore = parseFloat(w.bonus_balance);
    const lckBefore = parseFloat(w.locked_balance);

    let balAfter = balBefore + amount;
    let bonAfter = bonBefore;

    if (destination === 'BONUS_BALANCE') {
      bonAfter = bonBefore + amount;
      await qr.query(
        `UPDATE wallets SET balance = $1, bonus_balance = $2, updated_at = NOW() WHERE id = $3`,
        [balAfter, bonAfter, w.id],
      );
    } else {
      await qr.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
        [balAfter, w.id],
      );
    }

    await this.financialLedger.write({
      qr,
      walletId: w.id,
      userId,
      entryType: 'SPIN_WIN',
      flow: 'CREDIT',
      amount,
      balanceBefore: balBefore,
      balanceAfter: balAfter,
      bonusBefore: bonBefore,
      bonusAfter: bonAfter,
      lockedBefore: lckBefore,
      lockedAfter: lckBefore,
      referenceType: 'SPIN',
      referenceId: spinResultId,
      status: 'SUCCESS',
      description:
        destination === 'BONUS_BALANCE'
          ? 'Spin wheel prize credited to bonus_balance'
          : 'Spin wheel prize credited to balance',
      meta: { destination, wheelId, spinResultId },
      createdByType: 'SYSTEM',
    });
  }

  async getMyHistory(userId: number, q: MySpinHistoryQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const offset = (page - 1) * limit;

    const rows = await this.dataSource.query(
      `SELECT r.id, r.wheel_id, r.segment_position, r.segment_label,
              r.amount, r.turnover_multiplier, r.turnover_target,
              r.turnover_requirement_id, r.window_start, r.created_at,
              w.name AS wheel_name, w.currency
         FROM spin_results r
         JOIN spin_wheels w ON w.id = r.wheel_id
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM spin_results WHERE user_id = $1`,
      [userId],
    );

    return {
      data: rows.map((r: any) => ({
        id: Number(r.id),
        wheelId: Number(r.wheel_id),
        wheelName: r.wheel_name,
        currency: r.currency,
        position: Number(r.segment_position),
        label: r.segment_label,
        amount: parseFloat(r.amount),
        won: parseFloat(r.amount) > 0,
        turnoverMultiplier: parseFloat(r.turnover_multiplier),
        turnoverTarget: parseFloat(r.turnover_target),
        turnoverRequirementId: r.turnover_requirement_id
          ? Number(r.turnover_requirement_id) : null,
        windowStart: r.window_start,
        createdAt: r.created_at,
      })),
      total: cnt.total,
      page,
      limit,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — wheels
  // ═══════════════════════════════════════════════════════════════

  async list(q: ListSpinWheelsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];

    if (q.currency) { params.push(q.currency); where.push(`w.currency = $${params.length}`); }
    if (q.isActive !== undefined) { params.push(q.isActive); where.push(`w.is_active = $${params.length}`); }
    if (q.search) { params.push(`%${q.search}%`); where.push(`w.name ILIKE $${params.length}`); }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const rows = await this.dataSource.query(
      `SELECT w.*,
              (SELECT COUNT(*)::int FROM spin_wheel_segments s WHERE s.wheel_id = w.id) AS segment_rows,
              (SELECT COUNT(*)::int FROM spin_results r WHERE r.wheel_id = w.id) AS spin_count,
              (SELECT COALESCE(SUM(r.amount), 0) FROM spin_results r WHERE r.wheel_id = w.id) AS paid_total
         FROM spin_wheels w
         ${clause}
        ORDER BY w.is_active DESC, w.updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM spin_wheels w ${clause}`,
      params.slice(0, params.length - 2),
    );

    return { data: rows, total: cnt.total, page, limit };
  }

  async getOne(id: number) {
    const [wheel] = await this.dataSource.query(
      `SELECT * FROM spin_wheels WHERE id = $1 LIMIT 1`, [id],
    );
    if (!wheel) throw new NotFoundException('Spin wheel not found');

    const segments = await this.dataSource.query(
      `SELECT * FROM spin_wheel_segments WHERE wheel_id = $1 ORDER BY position ASC`,
      [id],
    );

    // Admins see the odds, and the implied probability so they do not have to
    // work it out from raw weights.
    const totalWeight = segments
      .filter((s: any) => s.is_active)
      .reduce((a: number, s: any) => a + Number(s.weight), 0);

    const win = await this.resolveWindow(this.dataSource, wheel);

    return {
      ...wheel,
      segments: segments.map((s: any) => ({
        ...s,
        chance: s.is_active && totalWeight > 0
          ? Math.round((Number(s.weight) / totalWeight) * 10000) / 100
          : 0,
      })),
      currentWindow: win,
      // Expected cost of one spin at the configured odds — the number that
      // decides whether this wheel is affordable.
      expectedCostPerSpin: totalWeight > 0
        ? this.round2(
            segments
              .filter((s: any) => s.is_active)
              .reduce((a: number, s: any) =>
                a + parseFloat(s.amount) * (Number(s.weight) / totalWeight), 0),
          )
        : 0,
    };
  }

  async create(dto: CreateSpinWheelDto, adminId: number) {
    const segmentCount = dto.segmentCount ?? 6;
    if (dto.segments) this.assertSegments(dto.segments, segmentCount);
    this.assertSchedule(dto);

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const [wheel] = await qr.query(
        `INSERT INTO spin_wheels
           (name, currency, segment_count, frequency, day_of_week, day_of_month,
            start_time, window_minutes, timezone, spins_per_window, bonus_to,
            min_vip_level, member_group_id, min_deposit_in_window,
            starts_at, ends_at, is_active, created_by_admin_id, updated_by_admin_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
         RETURNING *`,
        [
          dto.name,
          dto.currency ?? 'BDT',
          segmentCount,
          dto.frequency ?? 'WEEKLY',
          dto.dayOfWeek ?? null,
          dto.dayOfMonth ?? null,
          dto.startTime ?? '00:00',
          dto.windowMinutes ?? null,
          dto.timezone ?? 'Asia/Dhaka',
          dto.spinsPerWindow ?? 1,
          dto.bonusTo ?? 'BONUS_BALANCE',
          dto.minVipLevel ?? 0,
          dto.memberGroupId ?? null,
          dto.minDepositInWindow ?? null,
          dto.startsAt ?? null,
          dto.endsAt ?? null,
          dto.isActive ?? false,
          adminId,
        ],
      );

      if (dto.segments) {
        await this.writeSegments(qr, Number(wheel.id), dto.segments);
      }

      await qr.commitTransaction();
      return this.getOne(Number(wheel.id));
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async update(id: number, dto: UpdateSpinWheelDto, adminId: number) {
    const [existing] = await this.dataSource.query(
      `SELECT * FROM spin_wheels WHERE id = $1 LIMIT 1`, [id],
    );
    if (!existing) throw new NotFoundException('Spin wheel not found');

    const segmentCount = dto.segmentCount ?? Number(existing.segment_count);
    if (dto.segments) this.assertSegments(dto.segments, segmentCount);
    this.assertSchedule({ ...existing, ...dto } as any, existing);

    const map: Record<string, any> = {
      name: dto.name,
      currency: dto.currency,
      segment_count: dto.segmentCount,
      frequency: dto.frequency,
      day_of_week: dto.dayOfWeek,
      day_of_month: dto.dayOfMonth,
      start_time: dto.startTime,
      window_minutes: dto.windowMinutes,
      timezone: dto.timezone,
      spins_per_window: dto.spinsPerWindow,
      bonus_to: dto.bonusTo,
      min_vip_level: dto.minVipLevel,
      member_group_id: dto.memberGroupId,
      min_deposit_in_window: dto.minDepositInWindow,
      starts_at: dto.startsAt,
      ends_at: dto.endsAt,
      is_active: dto.isActive,
    };

    const sets: string[] = [];
    const params: any[] = [];
    for (const [col, val] of Object.entries(map)) {
      if (val === undefined) continue;
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      if (sets.length) {
        params.push(adminId);
        sets.push(`updated_by_admin_id = $${params.length}`);
        params.push(id);
        await qr.query(
          `UPDATE spin_wheels SET ${sets.join(', ')}, updated_at = NOW()
            WHERE id = $${params.length}`,
          params,
        );
      }

      if (dto.segments) {
        await this.writeSegments(qr, id, dto.segments);
      }

      // Going live with the wrong number of slices would 400 every player's
      // spin, so refuse it here instead.
      const goingLive = dto.isActive === true || (dto.isActive === undefined && existing.is_active);
      if (goingLive) await this.assertLiveable(qr, id, segmentCount);

      await qr.commitTransaction();
      return this.getOne(id);
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async replaceSegments(id: number, dto: ReplaceSegmentsDto, adminId: number) {
    const [wheel] = await this.dataSource.query(
      `SELECT * FROM spin_wheels WHERE id = $1 LIMIT 1`, [id],
    );
    if (!wheel) throw new NotFoundException('Spin wheel not found');

    this.assertSegments(dto.segments, Number(wheel.segment_count));

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await this.writeSegments(qr, id, dto.segments);
      await qr.query(
        `UPDATE spin_wheels SET updated_by_admin_id = $1, updated_at = NOW() WHERE id = $2`,
        [adminId, id],
      );
      await qr.commitTransaction();
      return this.getOne(id);
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  async deactivate(id: number, adminId: number) {
    const res = await this.dataSource.query(
      `UPDATE spin_wheels SET is_active = FALSE, updated_by_admin_id = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id`,
      [adminId, id],
    );
    // TypeORM returns [rows, affected] for UPDATE ... RETURNING.
    const rows = Array.isArray(res[0]) ? res[0] : res;
    if (!rows.length) throw new NotFoundException('Spin wheel not found');
    return { deactivated: true, id };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — results & stats
  // ═══════════════════════════════════════════════════════════════

  async listResults(q: ListSpinResultsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];

    if (q.wheelId) { params.push(q.wheelId); where.push(`r.wheel_id = $${params.length}`); }
    if (q.userId) { params.push(q.userId); where.push(`r.user_id = $${params.length}`); }
    if (q.from) { params.push(q.from); where.push(`r.created_at >= $${params.length}`); }
    if (q.to) { params.push(q.to); where.push(`r.created_at <= $${params.length}`); }
    if (q.winsOnly) where.push(`r.amount > 0`);
    if (q.search) {
      params.push(`%${q.search}%`);
      // A player's phone is NOT a column on `users` — it lives in
      // user_phone_numbers, one row per number. Same shape the member search uses.
      where.push(
        `(u.username ILIKE $${params.length}
          OR u.email ILIKE $${params.length}
          OR EXISTS (SELECT 1 FROM user_phone_numbers p
                      WHERE p.user_id = u.id
                        AND p.phone_number ILIKE $${params.length}))`,
      );
    }

    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    params.push(limit, offset);
    const rows = await this.dataSource.query(
      `SELECT r.*, u.username,
              (SELECT phone_number FROM user_phone_numbers
                WHERE user_id = u.id AND is_primary = TRUE LIMIT 1) AS primary_phone,
              w.name AS wheel_name, w.currency
         FROM spin_results r
         JOIN users u ON u.id = r.user_id
         JOIN spin_wheels w ON w.id = r.wheel_id
         ${clause}
        ORDER BY r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(r.amount), 0) AS paid_total
         FROM spin_results r
         JOIN users u ON u.id = r.user_id
         ${clause}`,
      params.slice(0, params.length - 2),
    );

    return {
      data: rows,
      total: cnt.total,
      paidTotal: parseFloat(cnt.paid_total),
      page,
      limit,
    };
  }

  /** Per-slice actual-vs-configured, which is how you spot a mis-weighted wheel. */
  async stats(wheelId: number) {
    const [wheel] = await this.dataSource.query(
      `SELECT * FROM spin_wheels WHERE id = $1 LIMIT 1`, [wheelId],
    );
    if (!wheel) throw new NotFoundException('Spin wheel not found');

    const [totals] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS spins,
              COUNT(DISTINCT user_id)::int AS players,
              COALESCE(SUM(amount), 0) AS paid_total,
              COUNT(*) FILTER (WHERE amount > 0)::int AS winning_spins
         FROM spin_results WHERE wheel_id = $1`,
      [wheelId],
    );

    const perSegment = await this.dataSource.query(
      `SELECT s.id, s.position, s.label, s.amount, s.weight, s.is_active,
              COUNT(r.id)::int AS hits,
              COALESCE(SUM(r.amount), 0) AS paid
         FROM spin_wheel_segments s
         LEFT JOIN spin_results r ON r.segment_id = s.id
        WHERE s.wheel_id = $1
        GROUP BY s.id
        ORDER BY s.position ASC`,
      [wheelId],
    );

    const spins = Number(totals.spins);
    const totalWeight = perSegment
      .filter((s: any) => s.is_active)
      .reduce((a: number, s: any) => a + Number(s.weight), 0);

    return {
      wheelId,
      name: wheel.name,
      spins,
      players: Number(totals.players),
      winningSpins: Number(totals.winning_spins),
      paidTotal: parseFloat(totals.paid_total),
      averagePerSpin: spins > 0 ? this.round2(parseFloat(totals.paid_total) / spins) : 0,
      segments: perSegment.map((s: any) => ({
        id: Number(s.id),
        position: Number(s.position),
        label: s.label,
        amount: parseFloat(s.amount),
        weight: Number(s.weight),
        hits: Number(s.hits),
        paid: parseFloat(s.paid),
        expectedChance: totalWeight > 0 && s.is_active
          ? Math.round((Number(s.weight) / totalWeight) * 10000) / 100 : 0,
        actualChance: spins > 0
          ? Math.round((Number(s.hits) / spins) * 10000) / 100 : 0,
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════

  private round2(n: number) {
    return Math.floor(n * 100) / 100;
  }

  /** Positions must cover 0..count-1 exactly once, or the wheel has a hole in it. */
  private assertSegments(segments: SpinSegmentDto[], expectedCount: number) {
    if (segments.length !== expectedCount) {
      throw new BadRequestException(
        `A ${expectedCount}-slice wheel needs exactly ${expectedCount} segments, got ${segments.length}`,
      );
    }
    const seen = new Set<number>();
    for (const s of segments) {
      if (s.position >= expectedCount) {
        throw new BadRequestException(
          `position ${s.position} is out of range for a ${expectedCount}-slice wheel (0–${expectedCount - 1})`,
        );
      }
      if (seen.has(s.position)) {
        throw new BadRequestException(`Duplicate segment position ${s.position}`);
      }
      seen.add(s.position);
    }
    const active = segments.filter((s) => s.isActive !== false);
    if (!active.length) throw new BadRequestException('At least one segment must be active');
    if (active.every((s) => (s.weight ?? 1) === 0)) {
      throw new BadRequestException(
        'Every active segment has weight 0 — nothing could ever be drawn',
      );
    }
  }

  private assertSchedule(dto: any, existing?: any) {
    const freq = (dto.frequency ?? existing?.frequency ?? 'WEEKLY').toUpperCase();
    if (freq === 'WEEKLY') {
      const dow = dto.dayOfWeek ?? dto.day_of_week ?? existing?.day_of_week;
      if (dow === null || dow === undefined) {
        throw new BadRequestException('dayOfWeek is required for a WEEKLY wheel (0 = Sunday)');
      }
    }
    if (freq === 'MONTHLY') {
      const dom = dto.dayOfMonth ?? dto.day_of_month ?? existing?.day_of_month;
      if (dom === null || dom === undefined) {
        throw new BadRequestException('dayOfMonth is required for a MONTHLY wheel (1–28)');
      }
    }
  }

  private async assertLiveable(qr: QueryRunner, wheelId: number, expectedCount: number) {
    const [row] = await qr.query(
      `SELECT COUNT(*)::int AS n FROM spin_wheel_segments
        WHERE wheel_id = $1 AND is_active = TRUE`,
      [wheelId],
    );
    if (Number(row.n) !== expectedCount) {
      throw new BadRequestException(
        `Cannot activate: the wheel has ${row.n} active slices but needs ${expectedCount}`,
      );
    }
  }

  /**
   * Replace the whole slice set.
   *
   * Rows are updated in place by position rather than deleted and re-inserted,
   * so `spin_results.segment_id` keeps pointing at a real row and the payout
   * history stays joinable.
   */
  private async writeSegments(qr: QueryRunner, wheelId: number, segments: SpinSegmentDto[]) {
    const keep = segments.map((s) => s.position);

    await qr.query(
      `DELETE FROM spin_wheel_segments
        WHERE wheel_id = $1 AND position <> ALL($2::int[])`,
      [wheelId, keep],
    );

    for (const s of segments) {
      await qr.query(
        `INSERT INTO spin_wheel_segments
           (wheel_id, position, label, amount, turnover_multiplier, weight, color, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (wheel_id, position) DO UPDATE SET
           label               = EXCLUDED.label,
           amount              = EXCLUDED.amount,
           turnover_multiplier = EXCLUDED.turnover_multiplier,
           weight              = EXCLUDED.weight,
           color               = EXCLUDED.color,
           is_active           = EXCLUDED.is_active,
           updated_at          = NOW()`,
        [
          wheelId,
          s.position,
          s.label ?? null,
          s.amount,
          s.turnoverMultiplier ?? 0,
          s.weight ?? 1,
          s.color ?? null,
          s.isActive ?? true,
        ],
      );
    }
  }
}
