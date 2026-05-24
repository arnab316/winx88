src/
├── main.ts                          ← add setGlobalPrefix here (optional)
├── app.module.ts                    ← add ServeStaticModule here (required for PDFs)
│
└── game/
    │
    │   ── EXISTING (untouched) ──────────────────────────────
    ├── game.service.ts              ← all core logic, placeBet, settleRound etc.
    ├── game.controller.ts           ← all original routes, NO changes needed
    ├── round-watcher.service.ts     ← existing cron, closes rounds every 10s
    │
    │   ── REPLACED ──────────────────────────────────────────
    ├── games.gateway.ts             ← your version + emitRoundClosed now accepts
    │                                   optional roundCode/drawTime fields
    ├── game.module.ts               ← additive: wires all new providers/controllers
    │
    │   ── NEW FILES ──────────────────────────────────────────
    ├── round-scheduler.service.ts   ← @Cron EVERY_MINUTE — spawns rounds
    ├── bet-ticket.service.ts        ← PDF builder (pdfkit + qrcode)
    ├── schedule.service.ts          ← schedule CRUD + generateBetTicket helper
    ├── schedule.controller.ts       ← admin schedule routes + /bet-with-ticket
    ├── lobby.service.ts             ← 3 new read queries
    ├── lobby.controller.ts          ← GET /games/lobby, hot-numbers/by-category,
    │                                   admin awaiting-result, result-declared,
    │                                   admin rounds/:roundId/players
    │
    └── dto/
        └── schedule.dto.ts          ← CreateScheduleDto / UpdateScheduleDto