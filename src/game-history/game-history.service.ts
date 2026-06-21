import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export type GameCategory = 'LOTTERY' | 'JACKPOT' | 'SLOT' | 'SPORTS';

export interface GameHistoryQuery {
  category?: GameCategory; // filter to one product; omit for all
  status?: string;         // WON | LOST | PLACED | CANCELLED
  settled?: boolean;       // true => WON/LOST/CANCELLED, false => PLACED
  providerId?: number;     // filter slots to one Palace provider
  from?: string;           // ISO date (inclusive)
  to?: string;             // ISO date (inclusive)
  page?: number;
  limit?: number;
}

/**
 * Unified per-user game history across all products.
 *
 * Two physical sources, normalised into one "wager" shape and merged with a
 * single UNION ALL so the feed paginates as one timeline:
 *
 *   - `bets`              → lottery + jackpot wagers (one row = one wager).
 *                           Jackpot is distinguished by games.display_category.
 *   - `slot_transactions` → Palace slots, which are ledger rows (bet/win/cancel
 *                           are separate rows). We collapse them per round_id
 *                           into one synthetic wager: amount = total staked,
 *                           actual_payout = total won, status derived from both.
 *
 * Normalised record shape (every category returns the same keys):
 *   refId, refCode, category, gameCode, gameName, betNumber,
 *   betAmount, payoutMultiplier, potentialPayout, actualPayout,
 *   status, placedAt, settledAt, roundCode, resultNumber
 */
@Injectable()
export class GameHistoryService {
  private readonly logger = new Logger(GameHistoryService.name);

  constructor(private readonly dataSource: DataSource) {}

  // ── Source A: lottery + jackpot, from the bets table ($1 = userId) ──────
  private betsSourceSql(): string {
    return `
      SELECT
        b.id::text                                            AS ref_id,
        b.bet_code                                            AS ref_code,
        CASE WHEN g.display_category = 'JACKPOT'
             THEN 'JACKPOT' ELSE 'LOTTERY' END                AS category,
        g.code                                                AS game_code,
        g.name                                                AS game_name,
        NULL::int                                             AS provider_id,
        NULL::text                                            AS provider_name,
        b.bet_number                                          AS bet_number,
        b.bet_amount::numeric                                 AS bet_amount,
        b.payout_multiplier::numeric                          AS payout_multiplier,
        b.potential_payout::numeric                           AS potential_payout,
        CASE
          WHEN b.result_status = 'WON'  THEN b.potential_payout::numeric
          WHEN b.result_status = 'LOST' THEN 0
          ELSE NULL
        END                                                   AS actual_payout,
        b.result_status                                       AS status,
        b.placed_at                                           AS placed_at,
        b.settled_at                                          AS settled_at,
        gr.round_code                                         AS round_code,
        res.result_number                                     AS result_number
      FROM bets b
      JOIN games g        ON g.id  = b.game_id
      JOIN game_rounds gr ON gr.id = b.round_id
      LEFT JOIN game_results res ON res.round_id = b.round_id
      WHERE b.user_id = $1
    `;
  }

  // ── Source B: Palace slots, collapsed per round from slot_transactions ──
  //  A round with only a `bet` row is LOST; with a `win` row WON; cancelled →
  //  CANCELLED. round_id can be NULL, so group by COALESCE(round_id, trans_guid).
  private slotSourceSql(): string {
    return `
      SELECT
        COALESCE(st.round_id, st.trans_guid)                  AS ref_id,
        COALESCE(st.round_id, st.trans_guid)                  AS ref_code,
        'SLOT'                                                AS category,
        MAX(st.game_code)                                     AS game_code,
        MAX(st.game_code)                                     AS game_name,
        MAX(st.provider_id)                                   AS provider_id,
        MAX(pp.name)                                          AS provider_name,
        NULL::text                                            AS bet_number,
        COALESCE(SUM(st.amount) FILTER (WHERE st.type = 'bet'), 0)  AS bet_amount,
        NULL::numeric                                         AS payout_multiplier,
        NULL::numeric                                         AS potential_payout,
        COALESCE(SUM(st.amount) FILTER (WHERE st.type = 'win'), 0)  AS actual_payout,
        CASE
          WHEN bool_or(st.is_cancelled) OR bool_or(st.type = 'cancel') THEN 'CANCELLED'
          WHEN COALESCE(SUM(st.amount) FILTER (WHERE st.type = 'win'), 0) > 0 THEN 'WON'
          ELSE 'LOST'
        END                                                   AS status,
        MIN(st.created_at)                                    AS placed_at,
        MAX(st.created_at)                                    AS settled_at,
        COALESCE(st.round_id, st.trans_guid)                  AS round_code,
        NULL::text                                            AS result_number
      FROM slot_transactions st
      LEFT JOIN palace_providers pp ON pp.provider_id = st.provider_id
      WHERE st.user_id = $1
      GROUP BY COALESCE(st.round_id, st.trans_guid)
    `;
  }

  // ── Source C: sportsbook wagers, from sports_bet_logs ───────────────────
  //  Logged by user_name (not user_id), so join users to filter by $1.
  //  One row = one bet slip. A slip is settled once settlement has run
  //  (settled_at / trans_hist_id set); until then it's open → PLACED.
  //
  //  Outcome of a settled slip is taken from win_amount, the real amount
  //  credited at settlement (0 for a loss) — so WON/LOST is a stored fact, not
  //  a guess. Legacy rows written before win_amount existed fall back to the
  //  provider's numeric status code in `type` (1/4/5 won-or-cashout,
  //  3/6/7/8 void/refund → cancelled, else lost). bet_amount is the stake.
  private sportsSourceSql(): string {
    return `
      SELECT
        sb.id::text                                          AS ref_id,
        COALESCE(sb.trans_id, sb.id::text)                   AS ref_code,
        'SPORTS'                                             AS category,
        'SPORTS'                                             AS game_code,
        COALESCE(NULLIF(sb.bet_list->'selections'->0->>'eventName', ''), 'Sportsbook') AS game_name,
        NULL::int                                            AS provider_id,
        NULL::text                                           AS provider_name,
        NULL::text                                           AS bet_number,
        sb.amount::numeric                                   AS bet_amount,
        NULLIF(sb.bet_list->>'totalOdds', '')::numeric       AS payout_multiplier,
        NULLIF(sb.bet_list->>'totalWin', '')::numeric        AS potential_payout,
        CASE
          WHEN sb.settled_at IS NULL AND sb.trans_hist_id IS NULL THEN NULL
          WHEN sb.win_amount IS NOT NULL                          THEN sb.win_amount
          WHEN sb.type IN ('1','4','5')  THEN NULLIF(sb.bet_list->>'totalWin', '')::numeric
          WHEN sb.type IN ('3','6','7','8')                       THEN NULL
          ELSE 0
        END                                                  AS actual_payout,
        CASE
          WHEN sb.settled_at IS NULL AND sb.trans_hist_id IS NULL THEN 'PLACED'
          WHEN sb.type IN ('3','6','7','8')                       THEN 'CANCELLED'
          WHEN sb.win_amount IS NOT NULL
               THEN CASE WHEN sb.win_amount > 0 THEN 'WON' ELSE 'LOST' END
          WHEN sb.type IN ('1','4','5')                           THEN 'WON'
          ELSE 'LOST'
        END                                                  AS status,
        sb.created_at                                        AS placed_at,
        COALESCE(
          sb.settled_at,
          CASE WHEN sb.trans_hist_id IS NULL THEN NULL ELSE sb.created_at END
        )                                                    AS settled_at,
        COALESCE(sb.trans_id, sb.id::text)                   AS round_code,
        NULL::text                                           AS result_number
      FROM sports_bet_logs sb
      -- Keyed by user_id (added + backfilled in migration 1890000000000), so
      -- sports filters by user_id like lottery (bets) and slots
      -- (slot_transactions). No more username string-join — the old source of
      -- silently-dropped sports history for email-style usernames.
      WHERE sb.user_id = $1
    `;
  }

  async getHistory(userId: number, q: GameHistoryQuery) {
    const page  = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const category = q.category;
    const status   = q.status?.toUpperCase();

    const betsSelect = this.betsSourceSql();
    const slotSelect = this.slotSourceSql();
    const sportsSelect = this.sportsSourceSql();

    // Decide which sources to union based on the category filter.
    const parts: string[] = [];
    if (!category || category === 'LOTTERY' || category === 'JACKPOT') {
      parts.push(betsSelect);
    }
    if (!category || category === 'SLOT') {
      parts.push(slotSelect);
    }
    if (!category || category === 'SPORTS') {
      parts.push(sportsSelect);
    }

    // Outer query applies category/status/date filters + pagination uniformly.
    const filters: string[] = [];
    const params: any[] = [userId];
    let i = 2;

    if (category) {
      filters.push(`h.category = $${i++}`);
      params.push(category);
    }
    if (status) {
      filters.push(`h.status = $${i++}`);
      params.push(status);
    }
    // Settled tab = finished wagers (WON/LOST/CANCELLED); Unsettled = PLACED.
    // Ignored when an explicit `status` is given.
    if (!status && q.settled !== undefined) {
      filters.push(
        q.settled
          ? `h.status IN ('WON','LOST','CANCELLED')`
          : `h.status = 'PLACED'`,
      );
    }
    if (q.providerId !== undefined) {
      filters.push(`h.provider_id = $${i++}`);
      params.push(q.providerId);
    }
    // Default window: last 7 days when no `from` is supplied.
    const fromTs = q.from
      ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    filters.push(`h.placed_at >= $${i++}`);
    params.push(fromTs);

    // `to` is inclusive of the whole day: a date-only string like
    // '2026-06-04' covers everything up to 2026-06-04 23:59:59.
    if (q.to) {
      filters.push(`h.placed_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.to);
    }
    const toTs = q.to ?? new Date().toISOString();

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const unioned = `(${parts.join('\n      UNION ALL\n')}) h`;

    this.logger.log(
      `[getHistory] userId=${userId} sources=[${
        category ?? 'ALL'
      }] status=${status ?? '-'} settled=${q.settled ?? '-'} ` +
        `providerId=${q.providerId ?? '-'} from=${fromTs} to=${toTs} page=${page} limit=${limit}`,
    );

    const rows = await this.dataSource.query(
      `SELECT * FROM ${unioned}
       ${whereClause}
       ORDER BY h.placed_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    const [cnt] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total FROM ${unioned} ${whereClause}`,
      params,
    );

    const [stats] = await this.dataSource.query(
      `SELECT
         COUNT(*)::int                                              AS total_bets,
         COUNT(*) FILTER (WHERE h.status = 'WON')::int             AS total_wins,
         COUNT(*) FILTER (WHERE h.status = 'LOST')::int            AS total_losses,
         COUNT(*) FILTER (WHERE h.status = 'PLACED')::int          AS total_pending,
         COUNT(*) FILTER (WHERE h.status = 'CANCELLED')::int       AS total_cancelled,
         COALESCE(SUM(h.bet_amount), 0)::numeric                   AS total_staked,
         COALESCE(SUM(h.actual_payout) FILTER (WHERE h.status = 'WON'), 0)::numeric AS total_won
       FROM ${unioned} ${whereClause}`,
      params,
    );

    // Per-category breakdown (LOTTERY / JACKPOT / SLOT) over the same filter set.
    const catRows = await this.dataSource.query(
      `SELECT
         h.category,
         COUNT(*)::int                                              AS total_bets,
         COUNT(*) FILTER (WHERE h.status = 'WON')::int             AS won,
         COUNT(*) FILTER (WHERE h.status = 'LOST')::int            AS lost,
         COUNT(*) FILTER (WHERE h.status = 'PLACED')::int          AS placed,
         COUNT(*) FILTER (WHERE h.status = 'CANCELLED')::int       AS cancelled,
         COALESCE(SUM(h.bet_amount), 0)::numeric                   AS staked,
         COALESCE(SUM(h.actual_payout) FILTER (WHERE h.status = 'WON'), 0)::numeric AS won_amount
       FROM ${unioned} ${whereClause}
       GROUP BY h.category`,
      params,
    );

    const total = cnt?.total ?? 0;
    const totalStaked = Number(stats?.total_staked ?? 0);
    const totalWon    = Number(stats?.total_won ?? 0);

    // Per-category counts make it obvious at a glance whether SPORTS (the
    // username-joined source) actually resolved any rows for this user.
    const byCategoryLog =
      catRows.map((c: any) => `${c.category}:${c.total_bets}`).join(',') ||
      'none';
    this.logger.log(
      `[getHistory] userId=${userId} returned total=${total} rows=${rows.length} byCategory=${byCategoryLog}`,
    );
    if (
      (!category || category === 'SPORTS') &&
      !catRows.some((c: any) => c.category === 'SPORTS')
    ) {
      this.logger.warn(
        `[getHistory] userId=${userId} no SPORTS rows in window — if the user placed bets, ` +
          `check sports_bet_logs.user_name vs users.username (name-join mismatch).`,
      );
    }

    return {
      data: rows.map((r: any) => ({
        refId:            r.ref_id,
        refCode:          r.ref_code,
        category:         r.category,
        gameCode:         r.game_code,
        gameName:         r.game_name,
        providerId:       r.provider_id === null ? null : Number(r.provider_id),
        providerName:     r.provider_name ?? null,
        betNumber:        r.bet_number,
        betAmount:        r.bet_amount === null ? null : Number(r.bet_amount),
        payoutMultiplier: r.payout_multiplier === null ? null : Number(r.payout_multiplier),
        potentialPayout:  r.potential_payout === null ? null : Number(r.potential_payout),
        actualPayout:     r.actual_payout === null ? null : Number(r.actual_payout),
        status:           r.status,
        placedAt:         r.placed_at,
        settledAt:        r.settled_at,
        roundCode:        r.round_code,
        resultNumber:     r.result_number,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
      window: { from: fromTs, to: toTs },
      summary: {
        totalBets:      stats?.total_bets ?? 0,
        totalWins:      stats?.total_wins ?? 0,
        totalLosses:    stats?.total_losses ?? 0,
        totalPending:   stats?.total_pending ?? 0,
        totalCancelled: stats?.total_cancelled ?? 0,
        totalStaked,
        totalWon,
        netPL: Number((totalWon - totalStaked).toFixed(2)),
      },
      byCategory: catRows.map((c: any) => {
        const staked = Number(c.staked ?? 0);
        const won    = Number(c.won_amount ?? 0);
        return {
          category:  c.category,
          totalBets: c.total_bets,
          won:       c.won,
          lost:      c.lost,
          placed:    c.placed,
          cancelled: c.cancelled,
          staked,
          won_amount: won,
          netPL: Number((won - staked).toFixed(2)),
        };
      }),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // GROUPED: provider × day cards (the "JILI · May 17 · ৳5" list).
  //   Each group carries totalGames, turnover (staked), totalWon, netPL.
  //   Drill down with getHistory({ providerId, category, from, to }) for the
  //   underlying game rows.
  // ════════════════════════════════════════════════════════════════════════
  async getHistoryByProvider(userId: number, q: GameHistoryQuery) {
    const category = q.category;

    const parts: string[] = [];
    if (!category || category === 'LOTTERY' || category === 'JACKPOT') {
      parts.push(this.betsSourceSql());
    }
    if (!category || category === 'SLOT') {
      parts.push(this.slotSourceSql());
    }
    if (!category || category === 'SPORTS') {
      parts.push(this.sportsSourceSql());
    }

    const filters: string[] = [];
    const params: any[] = [userId];
    let i = 2;

    if (category) {
      filters.push(`h.category = $${i++}`);
      params.push(category);
    }
    if (q.settled !== undefined) {
      filters.push(
        q.settled
          ? `h.status IN ('WON','LOST','CANCELLED')`
          : `h.status = 'PLACED'`,
      );
    }
    if (q.providerId !== undefined) {
      filters.push(`h.provider_id = $${i++}`);
      params.push(q.providerId);
    }
    const fromTs = q.from
      ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    filters.push(`h.placed_at >= $${i++}`);
    params.push(fromTs);
    if (q.to) {
      filters.push(`h.placed_at < ($${i++}::date + INTERVAL '1 day')`);
      params.push(q.to);
    }
    const toTs = q.to ?? new Date().toISOString();

    const whereClause = `WHERE ${filters.join(' AND ')}`;
    const unioned = `(${parts.join('\n      UNION ALL\n')}) h`;

    // Label a group: slot → provider name (or "Provider <id>" / "Slots"),
    // lottery/jackpot → the product name.
    const providerLabel = `
      COALESCE(
        h.provider_name,
        CASE
          WHEN h.category = 'SLOT' AND h.provider_id IS NOT NULL THEN 'Provider ' || h.provider_id
          WHEN h.category = 'SLOT' THEN 'Slots'
          ELSE initcap(lower(h.category))
        END
      )`;

    const rows = await this.dataSource.query(
      `SELECT
         TO_CHAR(h.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')          AS day,
         h.provider_id                                                  AS provider_id,
         ${providerLabel}                                               AS provider_name,
         h.category                                                     AS category,
         COUNT(*)::int                                                  AS total_games,
         COALESCE(SUM(h.bet_amount), 0)::numeric                        AS turnover,
         COALESCE(SUM(h.actual_payout) FILTER (WHERE h.status = 'WON'), 0)::numeric AS total_won
       FROM ${unioned}
       ${whereClause}
       GROUP BY TO_CHAR(h.placed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), h.provider_id, ${providerLabel}, h.category
       ORDER BY day DESC, provider_name ASC`,
      params,
    );

    return {
      window: { from: fromTs, to: toTs },
      groups: rows.map((r: any) => {
        const turnover = Number(r.turnover ?? 0);
        const totalWon = Number(r.total_won ?? 0);
        return {
          date:         r.day,
          providerId:   r.provider_id === null ? null : Number(r.provider_id),
          providerName: r.provider_name,
          category:     r.category,
          totalGames:   r.total_games,
          turnover,
          totalWon,
          netPL: Number((totalWon - turnover).toFixed(2)),
        };
      }),
    };
  }
}
