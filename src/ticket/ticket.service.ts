// src/ticket/ticket.service.ts
//
// Looks up a bet by bet_code and returns full verification data.
// Used by GET /ticket/:betCode (JSON) and GET /ticket/:betCode/view (HTML).

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class TicketService {
  constructor(private readonly dataSource: DataSource) {}

  async verifyTicket(betCode: string) {
    const rows = await this.dataSource.query(
      `SELECT
         b.id,
         b.bet_code,
         b.bet_number,
         b.bet_amount,
         b.payout_multiplier,
         b.potential_payout,
         b.result_status,
         b.placed_at,
         b.settled_at,
         b.ticket_url,

         -- Player
         u.full_name       AS player_name,
         u.username,

         -- Game
         g.id              AS game_id,
         g.name            AS game_name,
         g.code            AS game_code,
         g.digit_length,

         -- Round
         gr.id             AS round_id,
         gr.round_code,
         gr.status         AS round_status,
         gr.open_time,
         gr.close_time,
         gr.draw_time,

         -- Result (if declared)
         res.result_number

       FROM bets b
       LEFT JOIN users u          ON u.id = b.user_id
       LEFT JOIN games g          ON g.id = b.game_id
       LEFT JOIN game_rounds gr   ON gr.id = b.round_id
       LEFT JOIN game_results res ON res.round_id = b.round_id
       WHERE b.bet_code = $1
       LIMIT 1`,
      [betCode],
    );

    if (!rows.length) {
      throw new NotFoundException(`Ticket "${betCode}" not found`);
    }

    const row = rows[0];

    return {
      bet_code:         row.bet_code,
      bet_number:       row.bet_number,
      bet_amount:       row.bet_amount,
      payout_multiplier: row.payout_multiplier,
      potential_payout: row.potential_payout,
      result_status:    row.result_status,    // PLACED | WON | LOST | CANCELLED
      placed_at:        row.placed_at,
      settled_at:       row.settled_at,
      ticket_url:       row.ticket_url,

      player_name:      row.player_name ?? row.username ?? `User #${row.id}`,
      username:         row.username,

      game_id:          Number(row.game_id),
      game_name:        row.game_name,
      game_code:        row.game_code,
      digit_length:     Number(row.digit_length),

      round_id:         Number(row.round_id),
      round_code:       row.round_code,
      round_status:     row.round_status,
      open_time:        row.open_time,
      close_time:       row.close_time,
      draw_time:        row.draw_time,

      result_number:    row.result_number ?? null,

      // Derived helper for frontend
      is_winner: row.result_status === 'WON',
      is_settled: ['WON', 'LOST', 'CANCELLED'].includes(row.result_status),
    };
  }
}