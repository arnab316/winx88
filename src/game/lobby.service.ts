// // src/game/lobby.service.ts
// //
// // Three genuinely-missing read endpoints, built to be SAFE against the
// // current schema. They rely only on columns confirmed to exist:
// //   games:         id, code, name, digit_length, min_bet, max_bet,
// //                  payout_multiplier, is_active, created_at
// //   game_rounds:   id, game_id, round_code, open_time, close_time,
// //                  draw_time, status, source(after migration)
// //   game_results:  round_id (presence = "result declared")
// //   game_hot_numbers: game_id, number, is_active
// //   bets:          round_id, user_id, bet_amount, result_status
// //
// // They do NOT touch is_hot / display_category / hot_priority /
// // thumbnail_url / description, so they work whether or not those
// // optional columns exist on your games table.

// import { Injectable } from '@nestjs/common';
// import { DataSource } from 'typeorm';

// const DIGIT_LENGTHS = [1, 3, 4, 5] as const;

// @Injectable()
// export class LobbyService {
//   constructor(private readonly dataSource: DataSource) {}

//   // ════════════════════════════════════════════════════════════
//   // 1) HOT NUMBERS GROUPED BY CATEGORY (1D / 3D / 4D / 5D)
//   //    GET /games/hot-numbers/by-category
//   //
//   //    Returns active hot numbers for every active game, bucketed
//   //    by the game's digit_length.
//   // ════════════════════════════════════════════════════════════
//   async hotNumbersByCategory() {
//     const rows = await this.dataSource.query(
//       `SELECT
//          g.digit_length,
//          g.id        AS game_id,
//          g.code      AS game_code,
//          g.name      AS game_name,
//          hn.id       AS hot_number_id,
//          hn.number   AS hot_number,
//          hn.is_active
//        FROM game_hot_numbers hn
//        JOIN games g ON g.id = hn.game_id
//        WHERE hn.is_active = TRUE
//          AND g.is_active  = TRUE
//        ORDER BY g.digit_length ASC, g.id ASC, hn.id ASC`,
//     );

//     // Bucket into 1D / 3D / 4D / 5D
//     const buckets: Record<string, any> = {};
//     for (const dl of DIGIT_LENGTHS) {
//       buckets[`${dl}D`] = { digitLength: dl, games: {} as Record<string, any> };
//     }

//     for (const r of rows) {
//       const key = `${r.digit_length}D`;
//       if (!buckets[key]) {
//         buckets[key] = { digitLength: r.digit_length, games: {} };
//       }
//       const games = buckets[key].games;
//       if (!games[r.game_id]) {
//         games[r.game_id] = {
//           gameId: Number(r.game_id),
//           gameCode: r.game_code,
//           gameName: r.game_name,
//           hotNumbers: [],
//         };
//       }
//       games[r.game_id].hotNumbers.push({
//         id: Number(r.hot_number_id),
//         number: r.hot_number,
//       });
//     }

//     // Flatten games map -> array
//     return Object.entries(buckets).map(([category, v]: [string, any]) => ({
//       category,
//       digitLength: v.digitLength,
//       games: Object.values(v.games),
//     }));
//   }

//   // ════════════════════════════════════════════════════════════
//   // 2a) ADMIN: ROUNDS AWAITING RESULT (closed, no result declared)
//   //     GET /games/admin/rounds/awaiting-result
//   //
//   //     status = CLOSED  AND  no row in game_results.
//   //     Includes player/bet counts so admin sees exposure.
//   // ════════════════════════════════════════════════════════════
//   async roundsAwaitingResult() {
//     return this.dataSource.query(
//       `SELECT
//          gr.id            AS round_id,
//          gr.round_code,
//          gr.status,
//          gr.close_time,
//          gr.draw_time,
//          gr.source,
//          g.id             AS game_id,
//          g.code           AS game_code,
//          g.name           AS game_name,
//          g.digit_length,
//          COUNT(b.id)::int                                    AS total_bets,
//          COUNT(DISTINCT b.user_id)::int                      AS total_players,
//          COALESCE(SUM(b.bet_amount), 0)::numeric             AS total_stake,
//          COALESCE(SUM(b.potential_payout)
//                   FILTER (WHERE b.result_status = 'PLACED'), 0)::numeric
//                                                              AS max_exposure
//        FROM game_rounds gr
//        JOIN games g            ON g.id = gr.game_id
//        LEFT JOIN bets b        ON b.round_id = gr.id
//        LEFT JOIN game_results r ON r.round_id = gr.id
//        WHERE gr.status = 'CLOSED'
//          AND r.round_id IS NULL
//        GROUP BY gr.id, g.id
//        ORDER BY gr.draw_time ASC`,
//     );
//   }

//   // ════════════════════════════════════════════════════════════
//   // 2b) ADMIN: ROUNDS WITH RESULT DECLARED (published / settled)
//   //     GET /games/admin/rounds/result-declared
//   // ════════════════════════════════════════════════════════════
//   async roundsResultDeclared() {
//     return this.dataSource.query(
//       `SELECT
//          gr.id            AS round_id,
//          gr.round_code,
//          gr.status,
//          gr.close_time,
//          gr.draw_time,
//          gr.source,
//          g.id             AS game_id,
//          g.code           AS game_code,
//          g.name           AS game_name,
//          g.digit_length,
//          r.result_number,
//          r.created_at     AS result_declared_at,
//          COUNT(b.id)::int                                       AS total_bets,
//          COUNT(DISTINCT b.user_id)::int                         AS total_players,
//          COALESCE(SUM(b.bet_amount), 0)::numeric                AS total_stake,
//          COUNT(b.id) FILTER (WHERE b.result_status = 'WON')::int  AS winners,
//          COUNT(b.id) FILTER (WHERE b.result_status = 'LOST')::int AS losers,
//          COUNT(b.id) FILTER (WHERE b.result_status = 'PLACED')::int AS unsettled
//        FROM game_rounds gr
//        JOIN games g             ON g.id = gr.game_id
//        JOIN game_results r      ON r.round_id = gr.id
//        LEFT JOIN bets b         ON b.round_id = gr.id
//        GROUP BY gr.id, g.id, r.result_number, r.created_at
//        ORDER BY r.created_at DESC
//        LIMIT 200`,
//     );
//   }

//   // ════════════════════════════════════════════════════════════
//   // 2c) ADMIN: PLAYERS WHO BET ON A ROUND (the "player play list")
//   //     GET /games/admin/rounds/:roundId/players
//   // ════════════════════════════════════════════════════════════
//   async roundPlayers(roundId: number) {
//     return this.dataSource.query(
//       `SELECT
//          b.id            AS bet_id,
//          b.bet_code,
//          b.user_id,
//          u.full_name     AS player_name,
//          u.username,
//          b.bet_number,
//          b.bet_amount,
//          b.potential_payout,
//          b.result_status,
//          b.placed_at,
//          b.settled_at
//        FROM bets b
//        LEFT JOIN users u ON u.id = b.user_id
//        WHERE b.round_id = $1
//        ORDER BY b.placed_at ASC`,
//       [roundId],
//     );
//   }

//   // ════════════════════════════════════════════════════════════
//   // 3) USER LOBBY: live games + categories in ONE call
//   //    GET /games/lobby
//   //
//   //    For each active game with an OPEN round right now, returns the
//   //    game, its current round, and its active hot numbers, grouped by
//   //    digit_length category. One round-trip for the home screen.
//   // ════════════════════════════════════════════════════════════
//   async lobby() {
//     // Active games + their currently-open round (if any)
//     const games = await this.dataSource.query(
//       `SELECT
//          g.id, g.code, g.name, g.digit_length,
//          g.min_bet, g.max_bet, g.payout_multiplier,
//          lr.round_id, lr.round_code, lr.open_time, lr.close_time, lr.draw_time
//        FROM games g
//        LEFT JOIN LATERAL (
//          SELECT gr.id AS round_id, gr.round_code, gr.open_time,
//                 gr.close_time, gr.draw_time
//          FROM game_rounds gr
//          WHERE gr.game_id = g.id
//            AND gr.status  = 'OPEN'
//            AND gr.close_time > NOW()
//          ORDER BY gr.close_time ASC
//          LIMIT 1
//        ) lr ON TRUE
//        WHERE g.is_active = TRUE
//        ORDER BY g.digit_length ASC, g.id ASC`,
//     );

//     // Active hot numbers for all active games (one query, mapped in JS)
//     const hot = await this.dataSource.query(
//       `SELECT hn.game_id, hn.id, hn.number
//        FROM game_hot_numbers hn
//        JOIN games g ON g.id = hn.game_id
//        WHERE hn.is_active = TRUE AND g.is_active = TRUE
//        ORDER BY hn.game_id, hn.id`,
//     );

//     const hotByGame: Record<string, any[]> = {};
//     for (const h of hot) {
//       (hotByGame[h.game_id] ??= []).push({ id: Number(h.id), number: h.number });
//     }

//     // Group games by category
//     const categories: Record<string, any> = {};
//     for (const dl of DIGIT_LENGTHS) {
//       categories[`${dl}D`] = { category: `${dl}D`, digitLength: dl, games: [] as any[] };
//     }

//     for (const g of games) {
//       const key = `${g.digit_length}D`;
//       (categories[key] ??= { category: key, digitLength: g.digit_length, games: [] }).games.push({
//         gameId: Number(g.id),
//         gameCode: g.code,
//         gameName: g.name,
//         digitLength: g.digit_length,
//         minBet: parseFloat(g.min_bet),
//         maxBet: parseFloat(g.max_bet),
//         payoutMultiplier: parseFloat(g.payout_multiplier),
//         isLive: !!g.round_id,
//         currentRound: g.round_id
//           ? {
//               roundId: Number(g.round_id),
//               roundCode: g.round_code,
//               openTime: g.open_time,
//               closeTime: g.close_time,
//               drawTime: g.draw_time,
//             }
//           : null,
//         hotNumbers: hotByGame[g.id] ?? [],
//       });
//     }

//     return Object.values(categories);
//   }
// }


// src/game/lobby.service.ts
//
// Three genuinely-missing read endpoints, built to be SAFE against the
// current schema. They rely only on columns confirmed to exist:
//   games:         id, code, name, digit_length, min_bet, max_bet,
//                  payout_multiplier, is_active, created_at
//   game_rounds:   id, game_id, round_code, open_time, close_time,
//                  draw_time, status, source(after migration)
//   game_results:  round_id (presence = "result declared")
//   game_hot_numbers: game_id, number, is_active
//   bets:          round_id, user_id, bet_amount, result_status
//
// They do NOT touch is_hot / display_category / hot_priority /
// thumbnail_url / description, so they work whether or not those
// optional columns exist on your games table.

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

const DIGIT_LENGTHS = [1, 3, 4, 5] as const;

@Injectable()
export class LobbyService {
  constructor(private readonly dataSource: DataSource) {}

  // ════════════════════════════════════════════════════════════
  // 1) HOT NUMBERS GROUPED BY CATEGORY (1D / 3D / 4D / 5D)
  //    GET /games/hot-numbers/by-category
  //
  //    Returns active hot numbers for every active game, bucketed
  //    by the game's digit_length.
  // ════════════════════════════════════════════════════════════
  async hotNumbersByCategory() {
    const rows = await this.dataSource.query(
      `SELECT
         g.digit_length,
         g.id        AS game_id,
         g.code      AS game_code,
         g.name      AS game_name,
         hn.id       AS hot_number_id,
         hn.number   AS hot_number,
         hn.is_active
       FROM game_hot_numbers hn
       JOIN games g ON g.id = hn.game_id
       -- Only show hot numbers when the game has a live round RIGHT NOW
       WHERE (hn.expires_at IS NULL OR hn.expires_at > NOW())
         AND EXISTS (
           SELECT 1 FROM game_rounds gr
           WHERE gr.game_id = hn.game_id
             AND gr.status = 'OPEN'
             AND gr.close_time > NOW()
         )
       ORDER BY g.digit_length ASC, g.id ASC, hn.id ASC`,
    );

    // Bucket into 1D / 3D / 4D / 5D
    const buckets: Record<string, any> = {};
    for (const dl of DIGIT_LENGTHS) {
      buckets[`${dl}D`] = { digitLength: dl, games: {} as Record<string, any> };
    }

    for (const r of rows) {
      const key = `${r.digit_length}D`;
      if (!buckets[key]) {
        buckets[key] = { digitLength: r.digit_length, games: {} };
      }
      const games = buckets[key].games;
      if (!games[r.game_id]) {
        games[r.game_id] = {
          gameId: Number(r.game_id),
          gameCode: r.game_code,
          gameName: r.game_name,
          hotNumbers: [],
        };
      }
      games[r.game_id].hotNumbers.push({
        id: Number(r.hot_number_id),
        number: r.hot_number,
      });
    }

    // Flatten games map -> array
    return Object.entries(buckets).map(([category, v]: [string, any]) => ({
      category,
      digitLength: v.digitLength,
      games: Object.values(v.games),
    }));
  }

  // ════════════════════════════════════════════════════════════
  // 2a) ADMIN: ROUNDS AWAITING RESULT (closed, no result declared)
  //     GET /games/admin/rounds/awaiting-result
  //
  //     status = CLOSED  AND  no row in game_results.
  //     Includes player/bet counts so admin sees exposure.
  // ════════════════════════════════════════════════════════════
  async roundsAwaitingResult() {
    return this.dataSource.query(
      `SELECT
         gr.id            AS round_id,
         gr.round_code,
         gr.status,
         gr.close_time,
         gr.draw_time,
         gr.source,
         g.id             AS game_id,
         g.code           AS game_code,
         g.name           AS game_name,
         g.digit_length,
         COUNT(b.id)::int                                    AS total_bets,
         COUNT(DISTINCT b.user_id)::int                      AS total_players,
         COALESCE(SUM(b.bet_amount), 0)::numeric             AS total_stake,
         COALESCE(SUM(b.potential_payout)
                  FILTER (WHERE b.result_status = 'PLACED'), 0)::numeric
                                                             AS max_exposure
       FROM game_rounds gr
       JOIN games g            ON g.id = gr.game_id
       LEFT JOIN bets b        ON b.round_id = gr.id
       LEFT JOIN game_results r ON r.round_id = gr.id
       WHERE gr.status = 'CLOSED'
         AND r.round_id IS NULL
       GROUP BY gr.id, g.id
       ORDER BY gr.draw_time ASC`,
    );
  }

  // ════════════════════════════════════════════════════════════
  // 2b) ADMIN: ROUNDS WITH RESULT DECLARED (published / settled)
  //     GET /games/admin/rounds/result-declared
  // ════════════════════════════════════════════════════════════
  async roundsResultDeclared() {
    return this.dataSource.query(
      `SELECT
         gr.id            AS round_id,
         gr.round_code,
         gr.status,
         gr.close_time,
         gr.draw_time,
         gr.source,
         g.id             AS game_id,
         g.code           AS game_code,
         g.name           AS game_name,
         g.digit_length,
         r.result_number,
         r.created_at     AS result_declared_at,
         COUNT(b.id)::int                                       AS total_bets,
         COUNT(DISTINCT b.user_id)::int                         AS total_players,
         COALESCE(SUM(b.bet_amount), 0)::numeric                AS total_stake,
         COUNT(b.id) FILTER (WHERE b.result_status = 'WON')::int  AS winners,
         COUNT(b.id) FILTER (WHERE b.result_status = 'LOST')::int AS losers,
         COUNT(b.id) FILTER (WHERE b.result_status = 'PLACED')::int AS unsettled
       FROM game_rounds gr
       JOIN games g             ON g.id = gr.game_id
       JOIN game_results r      ON r.round_id = gr.id
       LEFT JOIN bets b         ON b.round_id = gr.id
       GROUP BY gr.id, g.id, r.result_number, r.created_at
       ORDER BY r.created_at DESC
       LIMIT 200`,
    );
  }

  // ════════════════════════════════════════════════════════════
  // 2c) ADMIN: PLAYERS WHO BET ON A ROUND (the "player play list")
  //     GET /games/admin/rounds/:roundId/players
  // ════════════════════════════════════════════════════════════
  async roundPlayers(roundId: number) {
    return this.dataSource.query(
      `SELECT
         b.id            AS bet_id,
         b.bet_code,
         b.user_id,
         u.full_name     AS player_name,
         u.username,
         b.bet_number,
         b.bet_amount,
         b.potential_payout,
         b.result_status,
         b.placed_at,
         b.settled_at
       FROM bets b
       LEFT JOIN users u ON u.id = b.user_id
       WHERE b.round_id = $1
       ORDER BY b.placed_at ASC`,
      [roundId],
    );
  }

  // ════════════════════════════════════════════════════════════
  // 3) USER LOBBY: live games + categories in ONE call
  //    GET /games/lobby
  //
  //    For each active game with an OPEN round right now, returns the
  //    game, its current round, and its active hot numbers, grouped by
  //    digit_length category. One round-trip for the home screen.
  // ════════════════════════════════════════════════════════════
  async lobby() {
    // Active games + their currently-open round (if any)
    const games = await this.dataSource.query(
      `SELECT
         g.id, g.code, g.name, g.digit_length,
         g.min_bet, g.max_bet, g.payout_multiplier,
         lr.round_id, lr.round_code, lr.open_time, lr.close_time, lr.draw_time
       FROM games g
       LEFT JOIN LATERAL (
         SELECT gr.id AS round_id, gr.round_code, gr.open_time,
                gr.close_time, gr.draw_time
         FROM game_rounds gr
         WHERE gr.game_id = g.id
           AND gr.status  = 'OPEN'
           AND gr.close_time > NOW()
         ORDER BY gr.close_time ASC
         LIMIT 1
       ) lr ON TRUE
       WHERE g.is_active = TRUE
       ORDER BY g.digit_length ASC, g.id ASC`,
    );

    // Active hot numbers for all active games (one query, mapped in JS)
    const hot = await this.dataSource.query(
      `SELECT hn.game_id, hn.id, hn.number
       FROM game_hot_numbers hn
       JOIN games g ON g.id = hn.game_id
       WHERE (hn.expires_at IS NULL OR hn.expires_at > NOW())
         AND EXISTS (
           SELECT 1 FROM game_rounds gr
           WHERE gr.game_id = hn.game_id
             AND gr.status = 'OPEN'
             AND gr.close_time > NOW()
         )
       ORDER BY hn.game_id, hn.id`,
    );

    const hotByGame: Record<string, any[]> = {};
    for (const h of hot) {
      (hotByGame[h.game_id] ??= []).push({ id: Number(h.id), number: h.number });
    }

    // Group games by category
    const categories: Record<string, any> = {};
    for (const dl of DIGIT_LENGTHS) {
      categories[`${dl}D`] = { category: `${dl}D`, digitLength: dl, games: [] as any[] };
    }

    for (const g of games) {
      const key = `${g.digit_length}D`;
      (categories[key] ??= { category: key, digitLength: g.digit_length, games: [] }).games.push({
        gameId: Number(g.id),
        gameCode: g.code,
        gameName: g.name,
        digitLength: g.digit_length,
        minBet: parseFloat(g.min_bet),
        maxBet: parseFloat(g.max_bet),
        payoutMultiplier: parseFloat(g.payout_multiplier),
        isLive: !!g.round_id,
        currentRound: g.round_id
          ? {
              roundId: Number(g.round_id),
              roundCode: g.round_code,
              openTime: g.open_time,
              closeTime: g.close_time,
              drawTime: g.draw_time,
            }
          : null,
        hotNumbers: hotByGame[g.id] ?? [],
      });
    }

    return Object.values(categories);
  }
}