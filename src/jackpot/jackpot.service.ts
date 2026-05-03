// src/jackpot/jackpot.service.ts
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialLedgerService } from '../ledger/financial-ledger.service';
import {
  CreateJackpotPoolDto,
  UpdateJackpotPoolDto,
  AdjustPrizeDto,
  PickWinnerDto,
  ListJackpotPoolsQueryDto,
  EligibilityRulesDto,
} from './dto/jackpot.dto';

/**
 * Single Responsibility: admin-managed prize event pools.
 *
 * Lifecycle:
 *   DRAFT     → admin can edit anything
 *   ACTIVE    → users see it; admin can adjust prize, see participants
 *   CLOSED    → past end date; admin must pick winner or cancel
 *   AWARDED   → winner picked, prize credited
 *   CANCELLED → admin cancelled before awarding
 *
 * Eligibility is computed from existing data (bets, users, member_groups).
 * No separate participant table — participants are a query result.
 */
@Injectable()
export class JackpotService {
  constructor(
    private dataSource: DataSource,
    private financialLedger: FinancialLedgerService,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CREATE POOL
  // ═════════════════════════════════════════════════════════════
  async createPool(dto: CreateJackpotPoolDto, adminId: number) {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    // Validate member group if provided in eligibility
    if (dto.eligibilityRules?.memberGroupId) {
      const g = await this.dataSource.query(
        `SELECT id FROM member_groups WHERE id = $1`,
        [dto.eligibilityRules.memberGroupId],
      );
      if (!g.length) throw new BadRequestException('Member group not found');
    }

    const result = await this.dataSource.query(
      `INSERT INTO jackpot_pools
        (name_en, name_bn, description_en, description_bn, banner_url,
         prize_amount, currency, starts_at, ends_at, eligibility_rules,
         status, created_by_admin_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'DRAFT',$11)
       RETURNING *`,
      [
        dto.nameEn,
        dto.nameBn ?? null,
        dto.descriptionEn ?? null,
        dto.descriptionBn ?? null,
        dto.bannerUrl ?? null,
        dto.prizeAmount,
        dto.currency ?? 'BDT',
        dto.startsAt,
        dto.endsAt,
        JSON.stringify(dto.eligibilityRules ?? {}),
        adminId,
      ],
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: UPDATE POOL (only DRAFT can be fully edited)
  //   Once ACTIVE, only prize can be adjusted via adjustPrize().
  // ═════════════════════════════════════════════════════════════
  async updatePool(id: number, dto: UpdateJackpotPoolDto) {
    const existing = await this.dataSource.query(
      `SELECT * FROM jackpot_pools WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Pool not found');

    const pool = existing[0];
    if (pool.status !== 'DRAFT') {
      throw new BadRequestException(
        `Pool is ${pool.status}. Only DRAFT pools can be updated. ` +
        `For prize amount changes on ACTIVE pools, use POST /jackpot/admin/:id/adjust-prize`,
      );
    }

    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;

    const map: Record<string, any> = {
      name_en:        dto.nameEn,
      name_bn:        dto.nameBn,
      description_en: dto.descriptionEn,
      description_bn: dto.descriptionBn,
      banner_url:     dto.bannerUrl,
      prize_amount:   dto.prizeAmount,
      starts_at:      dto.startsAt,
      ends_at:        dto.endsAt,
    };

    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val);
      }
    }
    if (dto.eligibilityRules !== undefined) {
      fields.push(`eligibility_rules = $${i++}::jsonb`);
      values.push(JSON.stringify(dto.eligibilityRules));
    }

    if (!fields.length) throw new BadRequestException('No fields to update');

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.dataSource.query(
      `UPDATE jackpot_pools SET ${fields.join(', ')}
       WHERE id = $${i} RETURNING *`,
      values,
    );
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: ACTIVATE (DRAFT → ACTIVE)
  // ═════════════════════════════════════════════════════════════
  async activatePool(id: number) {
    const result = await this.dataSource.query(
      `UPDATE jackpot_pools
       SET status = 'ACTIVE', activated_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'DRAFT'
       RETURNING *`,
      [id],
    );
    if (!result.length) {
      const check = await this.dataSource.query(
        `SELECT status FROM jackpot_pools WHERE id = $1`,
        [id],
      );
      if (!check.length) throw new NotFoundException('Pool not found');
      throw new BadRequestException(
        `Cannot activate pool with status ${check[0].status}`,
      );
    }
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CLOSE POOL (ACTIVE → CLOSED)
  //   Manual close before end date is OK. After end date, admin
  //   must close before picking winner.
  // ═════════════════════════════════════════════════════════════
  async closePool(id: number) {
    const result = await this.dataSource.query(
      `UPDATE jackpot_pools
       SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'ACTIVE'
       RETURNING *`,
      [id],
    );
    if (!result.length) {
      const check = await this.dataSource.query(
        `SELECT status FROM jackpot_pools WHERE id = $1`,
        [id],
      );
      if (!check.length) throw new NotFoundException('Pool not found');
      throw new BadRequestException(
        `Cannot close pool with status ${check[0].status}`,
      );
    }
    return result[0];
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: CANCEL POOL (any status except AWARDED)
  // ═════════════════════════════════════════════════════════════
  async cancelPool(id: number, reason: string) {
    const existing = await this.dataSource.query(
      `SELECT status FROM jackpot_pools WHERE id = $1`,
      [id],
    );
    if (!existing.length) throw new NotFoundException('Pool not found');
    if (existing[0].status === 'AWARDED') {
      throw new BadRequestException('Cannot cancel an already awarded pool');
    }

    await this.dataSource.query(
      `UPDATE jackpot_pools
       SET status = 'CANCELLED', updated_at = NOW(),
           winner_reason = COALESCE(winner_reason, $1)
       WHERE id = $2`,
      [`Cancelled: ${reason}`, id],
    );
    return { message: 'Pool cancelled', poolId: id };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: ADJUST PRIZE MID-EVENT
  //   Logged in jackpot_pool_adjustments for full audit trail.
  // ═════════════════════════════════════════════════════════════
  async adjustPrize(id: number, dto: AdjustPrizeDto, adminId: number) {
    if (dto.delta === 0) {
      throw new BadRequestException('Delta cannot be zero');
    }

    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const rows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!rows.length) throw new NotFoundException('Pool not found');
      const pool = rows[0];

      if (!['ACTIVE', 'DRAFT'].includes(pool.status)) {
        throw new BadRequestException(
          `Cannot adjust prize on ${pool.status} pool`,
        );
      }

      const before = parseFloat(pool.prize_amount);
      const after = before + dto.delta;
      if (after <= 0) {
        throw new BadRequestException(
          `Adjustment would make prize ${after}. Must stay > 0.`,
        );
      }

      await qr.query(
        `UPDATE jackpot_pools
         SET prize_amount = $1, updated_at = NOW()
         WHERE id = $2`,
        [after, id],
      );

      await qr.query(
        `INSERT INTO jackpot_pool_adjustments
          (pool_id, amount_before, amount_after, delta, reason, admin_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, before, after, dto.delta, dto.reason, adminId],
      );

      await qr.commitTransaction();
      return {
        message: 'Prize adjusted',
        poolId: id,
        before,
        after,
        delta: dto.delta,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: PICK WINNER (CLOSED → AWARDED)
  //   - Validates winner is eligible per pool's rules
  //   - Credits prize to winner's main balance (no rollover)
  //   - Writes financial_ledger row with reference to pool
  //   - Locks pool from further changes
  // ═════════════════════════════════════════════════════════════
  async pickWinner(id: number, dto: PickWinnerDto, adminId: number) {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();

    try {
      const poolRows = await qr.query(
        `SELECT * FROM jackpot_pools WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!poolRows.length) throw new NotFoundException('Pool not found');
      const pool = poolRows[0];

      if (pool.status !== 'CLOSED') {
        throw new BadRequestException(
          `Pool must be CLOSED before picking winner. Current: ${pool.status}. ` +
          `Use POST /jackpot/admin/:id/close first.`,
        );
      }

      // Verify user exists + is active
      const userRows = await qr.query(
        `SELECT id, full_name, account_status FROM users WHERE id = $1`,
        [dto.userId],
      );
      if (!userRows.length) throw new NotFoundException('User not found');
      if (userRows[0].account_status !== 'ACTIVE') {
        throw new ForbiddenException(
          `Cannot award prize to ${userRows[0].account_status} user`,
        );
      }

      // Verify eligibility — re-evaluates rules at award time
      const isEligible = await this.checkUserEligibility(qr, pool, dto.userId);
      if (!isEligible) {
        throw new ForbiddenException(
          `User does not meet this pool's eligibility rules. ` +
          `If you intend to override, modify the rules first or pick a different winner.`,
        );
      }

      // Credit prize to main balance
      const prizeAmount = parseFloat(pool.prize_amount);

      const walletRows = await qr.query(
        `SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE`,
        [dto.userId],
      );
      if (!walletRows.length) throw new NotFoundException('Winner wallet not found');
      const w = walletRows[0];

      const balBefore = parseFloat(w.balance);
      const bonBefore = parseFloat(w.bonus_balance);
      const lckBefore = parseFloat(w.locked_balance);
      const balAfter = balBefore + prizeAmount;

      await qr.query(
        `UPDATE wallets SET balance = $1, updated_at = NOW() WHERE id = $2`,
        [balAfter, w.id],
      );

      // Write ledger
      const ledgerResult = await this.financialLedger.write({
        qr,
        walletId:      w.id,
        userId:        dto.userId,
        entryType:     'JACKPOT_PRIZE',
        flow:          'CREDIT',
        amount:        prizeAmount,
        balanceBefore: balBefore,
        balanceAfter:  balAfter,
        bonusBefore:   bonBefore,
        bonusAfter:    bonBefore,
        lockedBefore:  lckBefore,
        lockedAfter:   lckBefore,
        referenceType: 'JACKPOT_POOL',
        referenceId:   id,
        status:        'SUCCESS',
        description:   `Jackpot prize from "${pool.name_en}": ${dto.reason}`,
        meta: {
          poolId: id,
          poolName: pool.name_en,
          adminId,
          reason: dto.reason,
        },
        createdByType: 'ADMIN',
        createdById:   adminId,
      });

      // Mark pool awarded
      await qr.query(
        `UPDATE jackpot_pools
         SET status = 'AWARDED',
             winner_user_id = $1,
             winner_picked_at = NOW(),
             winner_admin_id = $2,
             winner_reason = $3,
             winner_payout_ledger_id = $4,
             awarded_at = NOW(),
             updated_at = NOW()
         WHERE id = $5`,
        [dto.userId, adminId, dto.reason, ledgerResult ?? null, id],
      );

      await qr.commitTransaction();
      return {
        message: 'Winner picked and prize credited',
        poolId: id,
        winnerId: dto.userId,
        winnerName: userRows[0].full_name,
        prizeAmount,
        newBalance: balAfter,
      };
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE: ELIGIBILITY CHECK
  //   Evaluates rules against a specific user.
  //   Used during winner pick. Same rules used in getParticipants.
  // ═════════════════════════════════════════════════════════════
  private async checkUserEligibility(
    qr: any,
    pool: any,
    userId: number,
  ): Promise<boolean> {
    const rules: EligibilityRulesDto = pool.eligibility_rules ?? {};

    // No rules = everyone qualifies
    if (Object.keys(rules).length === 0) return true;

    // VIP level check
    if (rules.minVipLevel) {
      const u = await qr.query(
        `SELECT vip_level FROM users WHERE id = $1`,
        [userId],
      );
      if (!u.length) return false;
      if (Number(u[0].vip_level ?? 0) < rules.minVipLevel) return false;
    }

    // Member group check
    if (rules.memberGroupId) {
      const groupRow = await qr.query(
        `SELECT code FROM member_groups WHERE id = $1`,
        [rules.memberGroupId],
      );
      if (!groupRow.length) return false;

      // ALL group → everyone
      if (groupRow[0].code !== 'ALL') {
        const member = await qr.query(
          `SELECT 1 FROM member_group_users
           WHERE group_id = $1 AND user_id = $2 LIMIT 1`,
          [rules.memberGroupId, userId],
        );
        if (!member.length) return false;
      }
    }

    // Bet count / total bet during pool window
    if (rules.minBets || rules.minTotalBet) {
      const stats = await qr.query(
        `SELECT
           COUNT(*)::int                       AS bet_count,
           COALESCE(SUM(bet_amount), 0)::numeric AS total_bet
         FROM bets
         WHERE user_id = $1
           AND created_at >= $2
           AND created_at <= $3`,
        [userId, pool.starts_at, pool.ends_at],
      );

      if (rules.minBets && Number(stats[0].bet_count) < rules.minBets) return false;
      if (rules.minTotalBet && parseFloat(stats[0].total_bet) < rules.minTotalBet) return false;
    }

    return true;
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: GET PARTICIPANTS LIST
  //   Returns all eligible users for the pool with their bet stats.
  //   Used by admin UI when picking a winner.
  // ═════════════════════════════════════════════════════════════
  async getParticipants(poolId: number, page = 1, limit = 100) {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const offset = (Math.max(page, 1) - 1) * safeLimit;

    const poolRows = await this.dataSource.query(
      `SELECT * FROM jackpot_pools WHERE id = $1`,
      [poolId],
    );
    if (!poolRows.length) throw new NotFoundException('Pool not found');
    const pool = poolRows[0];
    const rules: EligibilityRulesDto = pool.eligibility_rules ?? {};

    // Build dynamic WHERE clause based on rules
    const params: any[] = [pool.starts_at, pool.ends_at];
    const userFilters: string[] = [];
    let i = 3;

    if (rules.minVipLevel) {
      userFilters.push(`u.vip_level >= $${i++}`);
      params.push(rules.minVipLevel);
    }

    if (rules.memberGroupId) {
      // Check if it's the ALL group (everyone qualifies)
      const groupRow = await this.dataSource.query(
        `SELECT code FROM member_groups WHERE id = $1`,
        [rules.memberGroupId],
      );
      if (groupRow.length && groupRow[0].code !== 'ALL') {
        userFilters.push(`EXISTS (
          SELECT 1 FROM member_group_users mgu
          WHERE mgu.user_id = u.id AND mgu.group_id = $${i++}
        )`);
        params.push(rules.memberGroupId);
      }
    }

    const userFilterSql = userFilters.length
      ? `AND ${userFilters.join(' AND ')}`
      : '';

    // Bet aggregates within the pool's window
    const havingParts: string[] = [];
    if (rules.minBets) {
      havingParts.push(`COUNT(b.id) >= ${Number(rules.minBets)}`);
    }
    if (rules.minTotalBet) {
      havingParts.push(`COALESCE(SUM(b.bet_amount), 0) >= ${Number(rules.minTotalBet)}`);
    }
    const havingSql = havingParts.length
      ? `HAVING ${havingParts.join(' AND ')}`
      : '';

    params.push(safeLimit, offset);
    const limitParam = i++;
    const offsetParam = i++;

    const data = await this.dataSource.query(
      `SELECT
         u.id, u.full_name, u.username, u.vip_level, u.account_status,
         COUNT(b.id)::int                         AS bet_count,
         COALESCE(SUM(b.bet_amount), 0)::numeric  AS total_bet,
         COALESCE(SUM(
           CASE WHEN b.result_status = 'WON' THEN b.potential_payout ELSE 0 END
         ), 0)::numeric                            AS total_won,
         u.created_at                              AS user_created_at
       FROM users u
       LEFT JOIN bets b
         ON b.user_id = u.id
        AND b.created_at >= $1
        AND b.created_at <= $2
       WHERE u.account_status = 'ACTIVE'
       ${userFilterSql}
       GROUP BY u.id
       ${havingSql}
       ORDER BY total_bet DESC, u.id ASC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    );

    return {
      pool: {
        id: pool.id,
        name_en: pool.name_en,
        prize_amount: parseFloat(pool.prize_amount),
        eligibility_rules: rules,
        starts_at: pool.starts_at,
        ends_at: pool.ends_at,
      },
      participants: data.map((r: any) => ({
        userId: Number(r.id),
        fullName: r.full_name,
        username: r.username,
        vipLevel: r.vip_level,
        betCount: Number(r.bet_count),
        totalBet: parseFloat(r.total_bet),
        totalWon: parseFloat(r.total_won),
      })),
      page,
      limit: safeLimit,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: LIST POOLS
  // ═════════════════════════════════════════════════════════════
  async listPools(q: ListJackpotPoolsQueryDto) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (q.status) {
      where.push(`status = $${i++}`);
      params.push(q.status);
    }
    if (q.currency) {
      where.push(`currency = $${i++}`);
      params.push(q.currency);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = q.limit ?? 20;
    const offset = ((q.page ?? 1) - 1) * limit;

    const data = await this.dataSource.query(
      `SELECT p.*,
              w.full_name AS winner_name, w.username AS winner_username
       FROM jackpot_pools p
       LEFT JOIN users w ON w.id = p.winner_user_id
       ${whereSql}
       ORDER BY p.starts_at DESC, p.id DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const count = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM jackpot_pools ${whereSql}`,
      params,
    );

    return { data, page: q.page ?? 1, limit, total: count[0].total };
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN: GET ONE POOL (with adjustments history)
  // ═════════════════════════════════════════════════════════════
  async getPool(id: number) {
    const poolRows = await this.dataSource.query(
      `SELECT p.*,
              w.full_name AS winner_name, w.username AS winner_username
       FROM jackpot_pools p
       LEFT JOIN users w ON w.id = p.winner_user_id
       WHERE p.id = $1`,
      [id],
    );
    if (!poolRows.length) throw new NotFoundException('Pool not found');

    const adjustments = await this.dataSource.query(
      `SELECT id, amount_before, amount_after, delta, reason, admin_id, created_at
       FROM jackpot_pool_adjustments
       WHERE pool_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    return {
      ...poolRows[0],
      adjustments,
    };
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: ACTIVE POOLS (for users)
  // ═════════════════════════════════════════════════════════════
  async getActivePoolsPublic(lang: 'en' | 'bn' = 'en') {
    const rows = await this.dataSource.query(
      `SELECT id, name_${lang} AS name, description_${lang} AS description,
              banner_url, prize_amount, currency, starts_at, ends_at,
              eligibility_rules
       FROM jackpot_pools
       WHERE status = 'ACTIVE'
         AND starts_at <= NOW()
         AND ends_at > NOW()
       ORDER BY ends_at ASC`,
    );
    return rows.filter((r: any) => r.name);   // skip rows with no translation
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC: PAST WINNERS (transparency / marketing)
  // ═════════════════════════════════════════════════════════════
  async getPastWinners(limit = 20, lang: 'en' | 'bn' = 'en') {
    return this.dataSource.query(
      `SELECT p.id, p.name_${lang} AS name, p.prize_amount, p.currency,
              p.awarded_at, u.username, u.full_name
       FROM jackpot_pools p
       JOIN users u ON u.id = p.winner_user_id
       WHERE p.status = 'AWARDED'
       ORDER BY p.awarded_at DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)],
    );
  }
}