# WinX88 — Complete API Endpoint Reference

Generated from the controllers on 2026-10-17. **499 endpoints** across 43 modules.

## Audience

| Audience | Count | Meaning |
|---|---|---|
| `public` | 87 | No authentication |
| `public+` | 10 | Works signed out; returns extra per-player fields with a token |
| `player` | 90 | Player JWT required |
| `ai-support` | 23 | Service key **and** player JWT (read-only support endpoints) |
| `admin` | 277 | Admin JWT required |
| `super-admin` | 10 | Super-admin only |
| `api-key` | 2 | Provider / service key |

> Provider callbacks (`/gold_api`, Palace, OroPlay, WinyPay) are deliberately
> unguarded at the route and authenticate inside the handler with a shared
> secret — they appear as `public` below.

## admin

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/search-users` | public |

## admin-activity

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/activity` | admin |
| GET | `/admin/activity/actions` | admin |

## affiliate

| Method | Path | Audience |
|---|---|---|
| GET | `/affiliate/admin/:affiliateUserId/ngr-history` | admin |
| PATCH | `/affiliate/admin/:affiliateUserId/revshare` | admin |
| POST | `/affiliate/admin/:userId/commission-adjust` | admin |
| GET | `/affiliate/admin/:userId/commission-ledger` | admin |
| PATCH | `/affiliate/admin/:userId/contact` | admin |
| GET | `/affiliate/admin/:userId/detail` | admin |
| GET | `/affiliate/admin/:userId/downline` | admin |
| PATCH | `/affiliate/admin/:userId/group` | admin |
| POST | `/affiliate/admin/:userId/password` | admin |
| GET | `/affiliate/admin/:userId/payouts` | admin |
| GET | `/affiliate/admin/:userId/players/activity` | admin |
| GET | `/affiliate/admin/:userId/players/report` | admin |
| PATCH | `/affiliate/admin/:userId/status` | admin |
| GET | `/affiliate/admin/:userId/weekly` | admin |
| GET | `/affiliate/admin/applications` | admin |
| POST | `/affiliate/admin/applications/:id/decide` | admin |
| PATCH | `/affiliate/admin/commission` | admin |
| POST | `/affiliate/admin/create` | admin |
| GET | `/affiliate/admin/groups` | admin |
| POST | `/affiliate/admin/groups` | admin |
| DELETE | `/affiliate/admin/groups/:id` | admin |
| PATCH | `/affiliate/admin/groups/:id` | admin |
| GET | `/affiliate/admin/list` | admin |
| POST | `/affiliate/admin/payouts/:id/mark-paid` | admin |
| GET | `/affiliate/admin/payouts/pending` | admin |
| POST | `/affiliate/admin/payouts/run` | admin |
| GET | `/affiliate/admin/revshare/config` | admin |
| PATCH | `/affiliate/admin/revshare/config` | admin |
| PATCH | `/affiliate/admin/toggle` | admin |
| GET | `/affiliate/admin/transfers` | admin |
| POST | `/affiliate/admin/transfers/:id/decide` | admin |
| GET | `/affiliate/admin/verifications` | admin |
| POST | `/affiliate/admin/verifications/:id/decide` | admin |
| POST | `/affiliate/admin/weekly/run` | admin |
| POST | `/affiliate/apply` | player |
| GET | `/affiliate/bonuses` | player |
| GET | `/affiliate/downline` | player |
| GET | `/affiliate/downline/:userId` | player |
| POST | `/affiliate/forgot-password` | public |
| POST | `/affiliate/login` | public |
| POST | `/affiliate/logout` | public |
| GET | `/affiliate/me/commission-ledger` | player |
| GET | `/affiliate/me/dashboard` | player |
| GET | `/affiliate/me/link` | player |
| GET | `/affiliate/me/overview` | player |
| GET | `/affiliate/me/payouts` | player |
| GET | `/affiliate/me/players` | player |
| GET | `/affiliate/me/players/activity` | player |
| GET | `/affiliate/me/players/report` | player |
| GET | `/affiliate/me/profile` | player |
| GET | `/affiliate/me/transfers` | player |
| POST | `/affiliate/me/transfers` | player |
| GET | `/affiliate/me/verification` | player |
| GET | `/affiliate/me/weekly/history` | player |
| GET | `/affiliate/me/weekly/overview` | player |
| POST | `/affiliate/register` | public |
| POST | `/affiliate/reset-password` | public |
| GET | `/affiliate/status` | player |
| GET | `/affiliate/summary` | player |
| POST | `/affiliate/verify-reset-otp` | public |
| GET | `/r/:code` | public |

## agents

| Method | Path | Audience |
|---|---|---|
| GET | `/agents/admin` | admin |
| POST | `/agents/admin` | admin |
| DELETE | `/agents/admin/:id` | admin |
| PATCH | `/agents/admin/:id` | admin |
| POST | `/agents/admin/bulk-upload` | admin |
| POST | `/agents/admin/qr-image` | admin |
| GET | `/agents/deposit-agent` | player |

## ai-support

| Method | Path | Audience |
|---|---|---|
| GET | `/internal/ai-support/bets` | ai-support |
| GET | `/internal/ai-support/bets/:betId` | ai-support |
| GET | `/internal/ai-support/bets/:betId/settlement` | ai-support |
| GET | `/internal/ai-support/bets/pending` | ai-support |
| GET | `/internal/ai-support/bonuses` | ai-support |
| GET | `/internal/ai-support/bonuses/:bonusId` | ai-support |
| GET | `/internal/ai-support/bonuses/:bonusId/progress` | ai-support |
| GET | `/internal/ai-support/bonuses/wagering` | ai-support |
| GET | `/internal/ai-support/deposits` | ai-support |
| GET | `/internal/ai-support/deposits/:depositId` | ai-support |
| GET | `/internal/ai-support/deposits/by-transaction/:transactionNumber` | ai-support |
| GET | `/internal/ai-support/kyc/status` | ai-support |
| GET | `/internal/ai-support/promotions/:promotionId` | ai-support |
| GET | `/internal/ai-support/promotions/active` | ai-support |
| GET | `/internal/ai-support/promotions/eligibility` | ai-support |
| GET | `/internal/ai-support/user/profile` | ai-support |
| GET | `/internal/ai-support/user/restrictions` | ai-support |
| GET | `/internal/ai-support/user/status` | ai-support |
| GET | `/internal/ai-support/wallet/summary` | ai-support |
| GET | `/internal/ai-support/wallet/transactions` | ai-support |
| GET | `/internal/ai-support/withdrawals` | ai-support |
| GET | `/internal/ai-support/withdrawals/:withdrawalId` | ai-support |
| GET | `/internal/ai-support/withdrawals/eligibility` | ai-support |

## announcement

| Method | Path | Audience |
|---|---|---|
| GET | `/announcements/active` | public |
| GET | `/announcements/admin` | admin |
| POST | `/announcements/admin` | admin |
| DELETE | `/announcements/admin/:id` | admin |
| PATCH | `/announcements/admin/:id` | admin |

## app.controller.ts

| Method | Path | Audience |
|---|---|---|
| GET | `/` | public |
| GET | `/details` | public |
| GET | `/health` | public |
| GET | `/stats` | public |
| GET | `/tables` | public |

## auth

| Method | Path | Audience |
|---|---|---|
| POST | `/auth/admin-login` | super-admin |
| POST | `/auth/admin-register` | super-admin |
| POST | `/auth/change-password` | player |
| GET | `/auth/check-username` | public |
| POST | `/auth/forgot-password` | public |
| GET | `/auth/isuername-taken/:username` | public |
| POST | `/auth/login` | super-admin |
| POST | `/auth/logout` | super-admin |
| GET | `/auth/profile/:userId` | super-admin |
| POST | `/auth/refresh-token` | super-admin |
| POST | `/auth/register` | super-admin |
| POST | `/auth/reset-password` | public |
| POST | `/auth/send-otp` | super-admin |
| POST | `/auth/verify-otp-register` | super-admin |
| POST | `/auth/verify-phone` | public |
| POST | `/auth/verify-reset-otp` | public |

## catalog

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/catalog` | admin |
| GET | `/admin/catalog/categories` | admin |
| GET | `/admin/catalog/games` | admin |

## channels

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/marketing/capi/events` | admin |
| GET | `/admin/marketing/channels` | admin |
| POST | `/admin/marketing/channels` | admin |
| DELETE | `/admin/marketing/channels/:id` | admin |
| PATCH | `/admin/marketing/channels/:id` | admin |
| GET | `/admin/marketing/clicks/unknown` | admin |
| GET | `/admin/marketing/domains` | admin |
| GET | `/admin/marketing/stats` | admin |
| GET | `/admin/marketing/vendors` | admin |
| POST | `/admin/marketing/vendors` | admin |
| PATCH | `/admin/marketing/vendors/:id` | admin |
| GET | `/admin/marketing/vendors/:id/keys` | admin |
| POST | `/admin/marketing/vendors/:id/keys` | admin |
| DELETE | `/admin/marketing/vendors/:id/keys/:keyId` | admin |
| GET | `/c/:channel` | public |
| POST | `/c/track` | public |
| GET | `/partner/channels` | api-key |
| GET | `/partner/stats` | api-key |

## coins

| Method | Path | Audience |
|---|---|---|
| POST | `/coins/admin/adjust` | admin |
| GET | `/coins/admin/settings` | admin |
| PATCH | `/coins/admin/settings` | admin |
| GET | `/coins/admin/user/:userId/history` | admin |
| GET | `/coins/me` | player |
| GET | `/coins/me/history` | player |

## dashboard

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/dashboard` | super-admin |

## game

| Method | Path | Audience |
|---|---|---|
| GET | `/games` | public |
| GET | `/games/:gameId/active-rounds` | public |
| GET | `/games/:gameId/hot-numbers` | public |
| GET | `/games/:gameId/results` | public |
| GET | `/games/:gameId/rounds` | public |
| GET | `/games/:id` | public |
| GET | `/games/active-rounds` | public |
| GET | `/games/admin/:gameId/hot-numbers` | admin |
| POST | `/games/admin/:gameId/open-round` | admin |
| PATCH | `/games/admin/:gameId/round-code` | admin |
| GET | `/games/admin/:gameId/rounds-overview` | admin |
| DELETE | `/games/admin/:gameId/schedule` | admin |
| GET | `/games/admin/:gameId/schedule` | admin |
| PATCH | `/games/admin/:gameId/schedule` | admin |
| POST | `/games/admin/:gameId/schedule` | admin |
| POST | `/games/admin/:gameId/schedule/pause-after-round` | admin |
| POST | `/games/admin/:gameId/schedule/toggle` | admin |
| DELETE | `/games/admin/:id` | admin |
| PATCH | `/games/admin/:id/code` | admin |
| PATCH | `/games/admin/:id/flags` | admin |
| PATCH | `/games/admin/:id/settings` | admin |
| POST | `/games/admin/create-round` | admin |
| POST | `/games/admin/create-with-round` | admin |
| POST | `/games/admin/hot-numbers` | admin |
| DELETE | `/games/admin/hot-numbers/:id` | admin |
| PATCH | `/games/admin/hot-numbers/:id` | admin |
| POST | `/games/admin/hot-numbers/:id/toggle` | admin |
| POST | `/games/admin/hot-numbers/reorder` | admin |
| GET | `/games/admin/list` | admin |
| GET | `/games/admin/rounds/:roundId/players` | admin |
| GET | `/games/admin/rounds/:roundId/stats` | admin |
| GET | `/games/admin/rounds/awaiting-result` | admin |
| GET | `/games/admin/rounds/result-declared` | admin |
| GET | `/games/admin/scheduler/health` | admin |
| GET | `/games/admin/schedules` | admin |
| POST | `/games/bet` | public |
| POST | `/games/bet-with-ticket` | admin |
| GET | `/games/by-type/:digitLength` | public |
| POST | `/games/create` | public |
| GET | `/games/hot` | public |
| POST | `/games/hot-number` | public |
| GET | `/games/hot-numbers/by-category` | public |
| GET | `/games/jackpot` | public |
| GET | `/games/lobby` | public |
| GET | `/games/my-bets` | player |
| POST | `/games/result/:round_id` | public |
| GET | `/games/results/feed` | public |
| POST | `/games/round` | public |
| GET | `/games/round/:roundId/result` | public |
| POST | `/games/settle/:round_id` | public |
| GET | `/games/with-active-rounds` | public |

## game-categories

| Method | Path | Audience |
|---|---|---|
| GET | `/game-categories` | admin |
| POST | `/game-categories` | admin |
| DELETE | `/game-categories/:id` | admin |
| PATCH | `/game-categories/:id` | admin |
| GET | `/game-categories/active` | public |
| PATCH | `/game-categories/reorder` | admin |
| GET | `/game-categories/sources` | admin |

## game-content

| Method | Path | Audience |
|---|---|---|
| GET | `/game-content` | admin |
| POST | `/game-content` | admin |
| DELETE | `/game-content/:id` | admin |
| PATCH | `/game-content/:id` | admin |
| GET | `/game-content/detail/:kind/:providerRef/:gameCode` | public+ |
| GET | `/game-content/detail/:kind/:providerRef/:gameCode/similar` | public+ |
| GET | `/game-content/list` | public+ |
| PATCH | `/game-content/reorder` | admin |
| POST | `/game-content/screenshot` | admin |
| GET | `/game-content/search-games` | admin |

## game-history

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/game-history` | admin |
| GET | `/admin/game-history/combine` | admin |
| GET | `/admin/game-history/daily` | admin |
| GET | `/me/game-history` | player |
| GET | `/me/game-history/by-provider` | player |
| GET | `/me/game-history/combine` | player |
| GET | `/me/game-history/settled` | player |
| GET | `/me/game-history/unsettled` | player |

## game-library

| Method | Path | Audience |
|---|---|---|
| GET | `/catalog/games` | public+ |
| GET | `/catalog/providers` | public+ |
| GET | `/me/continue-playing` | player |
| DELETE | `/me/favourites` | player |
| GET | `/me/favourites` | player |
| POST | `/me/favourites` | player |

## hero-banner

| Method | Path | Audience |
|---|---|---|
| GET | `/hero-banner` | admin |
| POST | `/hero-banner` | admin |
| DELETE | `/hero-banner/:id` | admin |
| PATCH | `/hero-banner/:id` | admin |
| PATCH | `/hero-banner/:id/toggle` | admin |
| GET | `/hero-banner/active` | public |

## home-shortcuts

| Method | Path | Audience |
|---|---|---|
| GET | `/home-shortcuts` | admin |
| POST | `/home-shortcuts` | admin |
| DELETE | `/home-shortcuts/:id` | admin |
| PATCH | `/home-shortcuts/:id` | admin |
| GET | `/home-shortcuts/active` | public |
| PATCH | `/home-shortcuts/reorder` | admin |

## jackpot

| Method | Path | Audience |
|---|---|---|
| POST | `/jackpot/:id/bet` | player |
| GET | `/jackpot/:id/hot-numbers` | public |
| GET | `/jackpot/:id/my-bets` | player |
| GET | `/jackpot/active` | public |
| GET | `/jackpot/admin` | admin |
| POST | `/jackpot/admin` | admin |
| GET | `/jackpot/admin/:id` | admin |
| PATCH | `/jackpot/admin/:id` | admin |
| POST | `/jackpot/admin/:id/activate` | admin |
| POST | `/jackpot/admin/:id/adjust-prize` | admin |
| GET | `/jackpot/admin/:id/bets` | admin |
| POST | `/jackpot/admin/:id/cancel` | admin |
| POST | `/jackpot/admin/:id/close` | admin |
| POST | `/jackpot/admin/:id/hot-numbers` | admin |
| DELETE | `/jackpot/admin/:id/hot-numbers/:hnId` | admin |
| POST | `/jackpot/admin/:id/publish-result` | admin |
| GET | `/jackpot/admin/:id/stats` | admin |
| GET | `/jackpot/history` | public |

## laaffic

| Method | Path | Audience |
|---|---|---|
| POST | `/laaffic/webhook/delivery` | public |

## member-group

| Method | Path | Audience |
|---|---|---|
| GET | `/member-group/admin` | admin |
| POST | `/member-group/admin` | admin |
| DELETE | `/member-group/admin/:id` | admin |
| GET | `/member-group/admin/:id` | admin |
| PATCH | `/member-group/admin/:id` | admin |
| POST | `/member-group/admin/:id/add-users` | admin |
| GET | `/member-group/admin/:id/members` | admin |
| POST | `/member-group/admin/:id/remove-users` | admin |
| GET | `/member-group/me` | player |

## nexus

| Method | Path | Audience |
|---|---|---|
| POST | `/gold_api` | public |
| GET | `/nexus/admin/curation/games` | admin |
| POST | `/nexus/admin/curation/override` | admin |
| POST | `/nexus/admin/curation/reapply` | admin |
| GET | `/nexus/admin/curation/rules` | admin |
| POST | `/nexus/admin/curation/rules` | admin |
| POST | `/nexus/admin/curation/rules/delete` | admin |
| POST | `/nexus/admin/curation/rules/preview` | admin |
| GET | `/nexus/admin/games` | admin |
| GET | `/nexus/admin/providers` | admin |
| POST | `/nexus/admin/sync` | admin |
| GET | `/nexus/games` | public+ |
| GET | `/nexus/launch` | public+ |
| GET | `/nexus/sportsbook/launch` | public+ |
| GET | `/nexus/vendors` | public+ |
| GET | `/nexus/vendors/grouped` | public+ |

## notification

| Method | Path | Audience |
|---|---|---|
| GET | `/notifications` | player |
| PATCH | `/notifications/:id/read` | player |
| GET | `/notifications/admin/health` | admin |
| POST | `/notifications/admin/send` | admin |
| GET | `/notifications/admin/templates` | admin |
| PUT | `/notifications/admin/templates` | admin |
| GET | `/notifications/preferences` | player |
| PUT | `/notifications/preferences` | player |
| GET | `/notifications/push/key` | public |
| GET | `/notifications/push/status` | player |
| POST | `/notifications/push/subscribe` | player |
| DELETE | `/notifications/push/unsubscribe` | player |
| POST | `/notifications/read-all` | player |
| GET | `/notifications/unread-count` | player |

## oroplay

| Method | Path | Audience |
|---|---|---|
| POST | `/api/balance` | public |
| POST | `/api/batch-transactions` | public |
| POST | `/api/transaction` | public |
| POST | `/oroplay/game-detail` | public |
| POST | `/oroplay/games` | public |
| GET | `/oroplay/history` | public |
| POST | `/oroplay/launch` | public |
| GET | `/oroplay/vendors` | public |
| GET | `/oroplay/vendors/grouped` | public |

## palace-casino

| Method | Path | Audience |
|---|---|---|
| POST | `/slot/callback` | public |
| POST | `/slot/games` | public |
| POST | `/slot/launch` | player |
| GET | `/slot/providers` | public |
| GET | `/slot/transactions` | public |
| POST | `/slot/wallet/deposit` | player |
| POST | `/slot/wallet/withdraw-all` | player |

## promo-banners

| Method | Path | Audience |
|---|---|---|
| GET | `/promo-banners` | admin |
| POST | `/promo-banners` | admin |
| DELETE | `/promo-banners/:id` | admin |
| PATCH | `/promo-banners/:id` | admin |
| GET | `/promo-banners/active` | public |
| PATCH | `/promo-banners/reorder` | admin |

## promotion

| Method | Path | Audience |
|---|---|---|
| GET | `/promotion/admin` | admin |
| POST | `/promotion/admin` | admin |
| DELETE | `/promotion/admin/:id` | admin |
| PATCH | `/promotion/admin/:id` | admin |
| GET | `/promotion/admin/:id/claims` | admin |
| GET | `/promotion/admin/:id/stats` | admin |
| POST | `/promotion/admin/approve-claim` | admin |
| POST | `/promotion/admin/cancel-claim` | admin |
| POST | `/promotion/admin/forfeit-claim` | admin |
| POST | `/promotion/admin/grant-manual` | admin |
| GET | `/promotion/admin/stats/overview` | admin |
| GET | `/promotion/admin/stats/summary` | admin |
| GET | `/promotion/me/available` | player |
| POST | `/promotion/me/claim-code` | player |
| GET | `/promotion/me/claims` | player |

## promotion-cms

| Method | Path | Audience |
|---|---|---|
| GET | `/promotion-cms/admin` | admin |
| POST | `/promotion-cms/admin` | admin |
| DELETE | `/promotion-cms/admin/:id` | admin |
| GET | `/promotion-cms/admin/:id` | admin |
| PATCH | `/promotion-cms/admin/:id` | admin |
| POST | `/promotion-cms/admin/reorder` | admin |
| POST | `/promotion-cms/admin/upload-banner` | admin |
| GET | `/promotion-cms/me` | player |
| GET | `/promotion-cms/me/:id` | player |
| GET | `/promotion-cms/public` | public |
| GET | `/promotion-cms/public/:id` | public |

## promotion-stats

| Method | Path | Audience |
|---|---|---|
| GET | `/promotion-stats/:promotionId` | admin |
| GET | `/promotion-stats/overview` | admin |

## rbac

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/rbac/admins` | admin |
| POST | `/admin/rbac/admins` | admin |
| DELETE | `/admin/rbac/admins/:id` | admin |
| PATCH | `/admin/rbac/admins/:id` | admin |
| PATCH | `/admin/rbac/admins/:id/role` | admin |
| PATCH | `/admin/rbac/admins/:id/roles` | admin |
| PATCH | `/admin/rbac/admins/:id/status` | admin |
| GET | `/admin/rbac/me` | admin |
| GET | `/admin/rbac/permissions` | admin |
| GET | `/admin/rbac/roles` | admin |
| POST | `/admin/rbac/roles` | admin |
| DELETE | `/admin/rbac/roles/:id` | admin |
| GET | `/admin/rbac/roles/:id` | admin |
| PATCH | `/admin/rbac/roles/:id` | admin |
| GET | `/admin/rbac/roles/:id/permissions` | admin |
| PUT | `/admin/rbac/roles/:id/permissions` | admin |

## referral

| Method | Path | Audience |
|---|---|---|
| GET | `/admin/referral-info-stat` | public |
| POST | `/admin/referral-info-stat` | public |
| DELETE | `/admin/referral-info-stat/:id` | public |
| GET | `/admin/referral-info-stat/:id` | public |
| PATCH | `/admin/referral-info-stat/:id` | public |
| GET | `/admin/referrals` | admin |
| PATCH | `/admin/referrals/:id/disqualify` | admin |
| POST | `/admin/referrals/:id/recompute` | admin |
| GET | `/admin/referrals/config` | admin |
| PATCH | `/admin/referrals/config` | admin |
| POST | `/admin/referrals/fraud-scan` | admin |
| GET | `/admin/referrals/leaderboard` | admin |
| POST | `/admin/referrals/recompute` | admin |
| GET | `/admin/referrals/referrers` | admin |
| GET | `/admin/referrals/referrers/:userId/referees` | admin |
| GET | `/admin/referrals/stats` | admin |
| GET | `/admin/referrals/tree/:userId` | admin |
| GET | `/referral/my-link` | player |
| GET | `/referral/my-referrals` | player |

## reports

| Method | Path | Audience |
|---|---|---|
| GET | `/reports/member-summary` | admin |
| GET | `/reports/member-summary/export` | admin |
| GET | `/reports/players` | admin |
| GET | `/reports/players/:userId` | admin |
| GET | `/reports/players/:userId/bets` | admin |
| GET | `/reports/players/:userId/transactions` | admin |

## spin

| Method | Path | Audience |
|---|---|---|
| GET | `/spin/admin` | admin |
| POST | `/spin/admin` | admin |
| DELETE | `/spin/admin/:id` | admin |
| GET | `/spin/admin/:id` | admin |
| PATCH | `/spin/admin/:id` | admin |
| PUT | `/spin/admin/:id/segments` | admin |
| GET | `/spin/admin/:id/stats` | admin |
| GET | `/spin/admin/results` | admin |
| GET | `/spin/me` | player |
| GET | `/spin/me/history` | player |
| POST | `/spin/me/spin` | player |
| GET | `/spin/public` | public |

## sports

| Method | Path | Audience |
|---|---|---|
| GET | `/sports/admin/bets` | admin |
| GET | `/sports/admin/callback-info` | admin |
| GET | `/sports/auth-games` | player |
| POST | `/sports/BetWin` | public |
| POST | `/sports/Deposit` | public |
| GET | `/sports/games` | public |
| GET | `/sports/games/:id` | player |
| POST | `/sports/GetBalance` | public |
| GET | `/sports/live-vendors` | public |
| GET | `/sports/logs` | player |
| GET | `/sports/my-bets` | player |
| GET | `/sports/sports-link` | player |
| POST | `/sports/sportsCallback` | public |
| POST | `/sports/updateLiveCasinoGames` | admin |
| POST | `/sports/updateSlotGames` | admin |
| POST | `/sports/Withdraw` | public |

## ticket

| Method | Path | Audience |
|---|---|---|
| GET | `/ticket/:betCode` | public |

## turnover

| Method | Path | Audience |
|---|---|---|
| POST | `/turnover/admin/:id/complete` | admin |
| GET | `/turnover/admin/requirements` | admin |
| GET | `/turnover/me` | player |
| GET | `/turnover/me/history` | player |
| GET | `/turnover/me/requirements` | player |

## twilio

| Method | Path | Audience |
|---|---|---|
| GET | `/twilio/test-twilio` | public |

## user

| Method | Path | Audience |
|---|---|---|
| POST | `/user/add-phone` | player |
| GET | `/user/admin/:userId` | admin |
| PATCH | `/user/admin/:userId` | admin |
| GET | `/user/admin/:userId/compliance` | admin |
| POST | `/user/admin/:userId/phone` | admin |
| DELETE | `/user/admin/:userId/phone/:phoneId` | admin |
| PATCH | `/user/admin/:userId/phone/:phoneId` | admin |
| PATCH | `/user/admin/:userId/phone/:phoneId/primary` | admin |
| PATCH | `/user/admin/:userId/phone/:phoneId/verify` | admin |
| GET | `/user/admin/:userId/remarks` | public |
| POST | `/user/admin/:userId/remarks` | public |
| DELETE | `/user/admin/:userId/remarks/:remarkId` | admin |
| PATCH | `/user/admin/:userId/remarks/:remarkId` | admin |
| GET | `/user/admin/all` | admin |
| GET | `/user/admin/members/search` | admin |
| GET | `/user/admin/search` | admin |
| GET | `/user/all` | player |
| DELETE | `/user/phone/:phoneId` | player |
| PATCH | `/user/phone/:phoneId/primary` | player |
| POST | `/user/phone/:phoneId/send-otp` | public |
| PATCH | `/user/phone/:phoneId/verify` | player |
| GET | `/user/profile` | player |
| POST | `/user/update-profile` | player |
| GET | `/user/user-details/:userId` | player |

## verification

| Method | Path | Audience |
|---|---|---|
| GET | `/verification/admin/:id` | admin |
| PATCH | `/verification/admin/:id/review` | admin |
| PATCH | `/verification/admin/:id/under-review` | admin |
| GET | `/verification/admin/list` | admin |
| GET | `/verification/admin/stats` | admin |
| GET | `/verification/admin/user/:userId` | admin |
| GET | `/verification/my-status` | player |
| POST | `/verification/submit` | player |

## vip

| Method | Path | Audience |
|---|---|---|
| GET | `/tiers/admin` | admin |
| POST | `/tiers/admin` | admin |
| PATCH | `/tiers/admin/:level` | admin |
| GET | `/tiers/admin/:level/banking` | admin |
| PATCH | `/tiers/admin/:level/banking` | admin |
| GET | `/tiers/admin/:level/banks` | admin |
| PUT | `/tiers/admin/:level/banks` | admin |
| PATCH | `/tiers/admin/:level/limits` | admin |
| POST | `/tiers/admin/:level/set-default` | admin |
| GET | `/tiers/admin/member-groups` | admin |
| GET | `/tiers/me/banking` | player |
| GET | `/tiers/public` | public |
| GET | `/vip/admin/config` | admin |
| POST | `/vip/admin/config` | admin |
| DELETE | `/vip/admin/config/:level` | admin |
| PATCH | `/vip/admin/config/:level` | admin |
| GET | `/vip/admin/levels/summary` | admin |
| POST | `/vip/admin/set-level` | admin |
| GET | `/vip/admin/stats` | admin |
| GET | `/vip/admin/users` | admin |
| GET | `/vip/admin/users/:level` | admin |
| GET | `/vip/levels` | player |
| GET | `/vip/me` | player |

## wallet

| Method | Path | Audience |
|---|---|---|
| POST | `/wallet/admin/adjust` | admin |
| GET | `/wallet/admin/adjustments` | admin |
| GET | `/wallet/admin/deposits` | player |
| GET | `/wallet/admin/deposits/:id` | player |
| POST | `/wallet/admin/deposits/:id/decide` | admin |
| POST | `/wallet/admin/deposits/:id/reopen` | admin |
| GET | `/wallet/admin/gateways` | admin |
| POST | `/wallet/admin/manual-deposit` | admin |
| GET | `/wallet/admin/transactions` | admin |
| GET | `/wallet/admin/withdrawals` | player |
| POST | `/wallet/admin/withdrawals/:id/decide` | admin |
| GET | `/wallet/balance` | player |
| POST | `/wallet/deposit` | player |
| POST | `/wallet/deposit/validate` | player |
| GET | `/wallet/history` | player |
| POST | `/wallet/withdraw` | player |

## winypay

| Method | Path | Audience |
|---|---|---|
| POST | `/winypay/deposit` | player |
| POST | `/winypay/deposit/callback` | player |
