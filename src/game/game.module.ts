// import { Module } from '@nestjs/common';
// import { GameService } from './game.service';
// import { GameController } from './game.controller';
// import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
// import { GameValidationService } from './game-validation.service';
// import { TurnoverModule } from 'src/turnover/turnover.module';
// import { AuthModule } from 'src/auth/auth.module';
// import { TurnoverService } from 'src/turnover/turnover.service';
// import { RoundWatcherService } from './round-watcher.service';
// import { GamesGateway } from './games.gateway';

// @Module({
//      imports: [AuthModule, TurnoverModule],
//     providers: [
//     GameService,
//     GameValidationService,                                            // ← ADD
//     JwtAuthGuard,
//     TurnoverService,
//     GamesGateway,           // ← new
//     RoundWatcherService,    // ← new
//   ],
//   controllers: [GameController],
//    exports: [GameValidationService],
// })
// export class GameModule {}


// src/game/game.module.ts
//
// ADDITIVE update of your existing GameModule.
// Keeps: AuthModule, TurnoverModule, GameValidationService, JwtAuthGuard,
//        TurnoverService, GamesGateway, RoundWatcherService.
// Adds:  ScheduleController, ScheduleService, BetTicketService,
//        RoundSchedulerService.
//
// NOTE on ScheduleModule:
//   Do NOT call ScheduleModule.forRoot() here — it is ALREADY registered
//   once in AppModule. Calling forRoot() twice double-registers the cron
//   manager. @Cron decorators work app-wide from the single AppModule
//   registration, so this module needs no schedule import at all.
//
// NOTE on FinancialLedgerService:
//   It comes from LedgerModule which is @Global(), so it's injectable here
//   without importing anything.

import { Module } from '@nestjs/common';

// ── Controllers ──────────────────────────────────────────────
import { GameController } from './game.controller';
import { ScheduleController } from './schedule.controller';
import { LobbyController } from './lobby.controller';

// ── Services ─────────────────────────────────────────────────
import { GameService } from './game.service';
import { GameValidationService } from './game-validation.service';
import { ScheduleService } from './schedule.service';
import { BetTicketService } from './bet-ticket.service';
import { RoundSchedulerService } from './round-scheduler.service';
import { RoundWatcherService } from './round-watcher.service';
import { LobbyService } from './lobby.service';

// ── Shared / infrastructure ──────────────────────────────────
import { GamesGateway } from './games.gateway';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { TurnoverService } from 'src/turnover/turnover.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule, TurnoverModule],
  controllers: [LobbyController, ScheduleController, GameController],
  providers: [
    GameService,
    GameValidationService,
    JwtAuthGuard,
    TurnoverService,
    GamesGateway,
    RoundWatcherService,
    // ── new ──
    ScheduleService,
    BetTicketService,
    RoundSchedulerService,
    LobbyService,
  ],
  exports: [GameValidationService],
})
export class GameModule {}