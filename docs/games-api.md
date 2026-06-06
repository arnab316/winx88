# WinX Games API

Reference for the **Games module**. Generated from the controllers — accurate to current code.

- **Base URL:** `{{baseUrl}}` (e.g. `http://localhost:3000`) — there is **no global prefix**; all routes are under `/games`.
- **Response envelope:** `{ statusCode, message, data }` (list endpoints may add `count` / pagination fields).

## Auth

| Level | Header |
|---|---|
| 🟢 Public | none |
| 🔴 Admin | `Authorization: Bearer <adminJwt>` |

---

## 🟢 Public — player-facing reads

| Method | Path | Query / Params | Purpose |
|---|---|---|---|
| GET | `/games/lobby` | — | Home screen: active games + current live round + hot numbers, grouped by 1D/3D/4D/5D. |
| GET | `/games` | `isActive`, `isHot`, `isJackpotBadge`, `category`(REGULAR\|JACKPOT\|INSTANT\|CUSTOM), `digitLength`(1\|3\|4\|5), `liveOnly`(bool) | Filterable game list. |
| GET | `/games/hot` | — | Hot-flagged games. |
| GET | `/games/jackpot` | — | Jackpot-badged games. |
| GET | `/games/by-type/:digitLength` | `:digitLength`=1\|3\|4\|5 | Games of one digit type. |
| GET | `/games/with-active-rounds` | — | Games that currently have an open round. |
| GET | `/games/active-rounds` | `digitLength`(0=all), `gameId`(0=all) | All currently-open rounds. |
| GET | `/games/:id` | `:id` | Single game detail + summary counts. |
| GET | `/games/:gameId/rounds` | `status`(OPEN\|CLOSED\|RESULT_PUBLISHED\|SETTLED), `date`, `limit`(50) | Rounds for a game. |
| GET | `/games/:gameId/active-rounds` | `:gameId` | Open rounds for a game. |
| GET | `/games/:gameId/results` | `limit`(20) | Recent results for a game. |
| GET | `/games/:gameId/hot-numbers` | `:gameId` | Public hot numbers for a game. |
| GET | `/games/round/:roundId/result` | `:roundId` | Result of one round. |
| GET | `/games/results/feed` | `hours`(24), `gameId`(0=all), `digitLength`(0=all), `limit`(50) | Global recent-results feed. |
| GET | `/games/hot-numbers/by-category` | — | Hot numbers grouped by category (live games only). |

---



## 🔴 Admin — requires admin JWT

### Games
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/games/admin/list` | — | All games (incl. inactive). |
| POST | `/games/admin/create-with-round` | `{ code, name, digit_length, min_bet, max_bet, payout_multiplier, description?, thumbnail_url?, display_category?, max_payout_per_round? }` | Create game + first round. |
| PATCH | `/games/admin/:id/settings` | `{ name?, payoutMultiplier?, minBet?, maxBet?, maxPayoutPerRound? }` | Edit game economics (partial). |
| PATCH | `/games/admin/:id/flags` | `{ isHot?, isJackpotBadge?, isActive?, displayCategory?, hotPriority?, maxPayoutPerRound?, description?, thumbnailUrl? }` | Toggle flags / display. |
| DELETE | `/games/admin/:id` | query `hard`(bool) | Delete game (soft unless `hard=true`). |

### Rounds
| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| POST | `/games/admin/create-round` | `{ game_id, ... }` | Create a round manually. |
| GET | `/games/admin/rounds/:roundId/stats` | `:roundId` | Per-number bet breakdown / exposure. |
| GET | `/games/admin/:gameId/rounds-overview` | `status` | Rounds overview for a game. |
| GET | `/games/admin/rounds/awaiting-result` | `page`(1), `limit`(20) | Closed rounds with no result yet. |
| GET | `/games/admin/rounds/result-declared` | `page`(1), `limit`(20) | Rounds published/settled. |
| GET | `/games/admin/rounds/:roundId/players` | `:roundId` | Players/bets in a round. |

### Hot numbers
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/games/admin/:gameId/hot-numbers` | query `includeInactive`(bool) | List (admin). |
| POST | `/games/admin/hot-numbers` | `{ gameId, number, priority?, note?, isActive? }` | Create. |
| PATCH | `/games/admin/hot-numbers/:id` | `{ number?, priority?, note?, isActive? }` | Update. |
| DELETE | `/games/admin/hot-numbers/:id` | — | Delete. |
| POST | `/games/admin/hot-numbers/:id/toggle` | — | Toggle active. |
| POST | `/games/admin/hot-numbers/reorder` | `{ items: [{ id, priority }] }` | Bulk reorder. |

### Schedules (auto round-spawning)
| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/games/admin/schedules` | — | List all schedules. |
| GET | `/games/admin/scheduler/health` | — | Health check — flags stale schedules. |
| GET | `/games/admin/:gameId/schedule` | `:gameId` | One game's schedule. |
| POST | `/games/admin/:gameId/schedule` | `{ intervalMinutes, betDurationMinutes, drawOffsetMinutes, roundCodePrefix, nextRunAt?, isActive? }` | Create. Rule: `betDurationMinutes < intervalMinutes`. |
| PATCH | `/games/admin/:gameId/schedule` | same fields, all optional | Update (partial). |
| DELETE | `/games/admin/:gameId/schedule` | — | Delete (stops auto-spawn). |
| POST | `/games/admin/:gameId/schedule/toggle` | — | Pause / resume. |

---

## ⚠️ Currently UNGUARDED write endpoints (use with care)

These have no auth guard yet. The state/money-changing ones should be treated as admin-only; prefer the guarded equivalents.

| Method | Path | Body |
|---|---|---|
| POST | `/games/bet` | `{ user_id, game_id, round_id, bet_number, amount }` |
| POST | `/games/settle/:round_id` | `{ result_number }` |
| POST | `/games/create` | game fields |
| POST | `/games/round` | round fields |
| POST | `/games/hot-number` | hot-number fields |
| POST | `/games/result/:round_id` | `{ result_number }` |
