// // src/game/schedule.controller.ts
// //
// // Admin endpoints for game_schedules + a bet-with-ticket wrapper.
// //
// // NOTE: routes live under the same 'games' prefix as GameController.
// // Nest allows two controllers sharing a prefix as long as no two
// // methods map to the same METHOD+path. All routes here are new.

// import {
//   Controller, Get, Post, Patch, Delete, Body, Param, Req,
//   HttpStatus, HttpException, ParseIntPipe,
//   UseGuards, UsePipes, ValidationPipe,
// } from '@nestjs/common';
// import { ScheduleService } from './schedule.service';
// import { GameService } from './game.service';
// import { AdminGuard } from '../common/guards/admin.guard';
// import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
// import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
// import { DataSource } from 'typeorm';

// @Controller('games')
// @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
// export class ScheduleController {
//   constructor(
//     private readonly scheduleService: ScheduleService,
//     private readonly gameService: GameService,
//     private readonly dataSource: DataSource,
//   ) {}

//   // ╔═══════════════════════════════════════════════════════╗
//   // ║  SCHEDULE CRUD  (admin only)                          ║
//   // ╚═══════════════════════════════════════════════════════╝

//   // GET /games/admin/schedules
//   @UseGuards(AdminGuard)
//   @Get('admin/schedules')
//   async listSchedules() {
//     try {
//       const data = await this.scheduleService.listSchedules();
//       return { statusCode: HttpStatus.OK, message: 'Schedules', count: data.length, data };
//     } catch (e: any) {
//       throw new HttpException(
//         { statusCode: e?.status || 500, message: e?.message || 'Error' },
//         e?.status || 500,
//       );
//     }
//   }

//   // GET /games/admin/:gameId/schedule
//   @UseGuards(AdminGuard)
//   @Get('admin/:gameId/schedule')
//   async getSchedule(@Param('gameId', ParseIntPipe) gameId: number) {
//     try {
//       const data = await this.scheduleService.getSchedule(gameId);
//       return { statusCode: HttpStatus.OK, message: 'Schedule', data };
//     } catch (e: any) {
//       throw new HttpException(
//         { statusCode: e?.status || 500, message: e?.message || 'Error' },
//         e?.status || 500,
//       );
//     }
//   }

//   // POST /games/admin/:gameId/schedule
//   @UseGuards(AdminGuard)
//   @Post('admin/:gameId/schedule')
//   async createSchedule(
//     @Param('gameId', ParseIntPipe) gameId: number,
//     @Body() dto: CreateScheduleDto,
//     @Req() req: any,
//   ) {
//     try {
//       const data = await this.scheduleService.createSchedule(gameId, dto, req.user?.sub);
//       return { statusCode: HttpStatus.CREATED, message: 'Schedule created', data };
//     } catch (e: any) {
//       throw new HttpException(
//         { statusCode: e?.status || 500, message: e?.message || 'Error' },
//         e?.status || 500,
//       );
//     }
//   }

//   // PATCH /games/admin/:gameId/schedule
//   @UseGuards(AdminGuard)
//   @Patch('admin/:gameId/schedule')
//   async updateSchedule(
//     @Param('gameId', ParseIntPipe) gameId: number,
//     @Body() dto: UpdateScheduleDto,
//   ) {
//     try {
//       const data = await this.scheduleService.updateSchedule(gameId, dto);
//       return { statusCode: HttpStatus.OK, message: 'Schedule updated', data };
//     } catch (e: any) {
//       throw new HttpException(
//         { statusCode: e?.status || 500, message: e?.message || 'Error' },
//         e?.status || 500,
//       );
//     }
//   }

//   // DELETE /games/admin/:gameId/schedule
//   @UseGuards(AdminGuard)
//   @Delete('admin/:gameId/schedule')
//   async deleteSchedule(@Param('gameId', ParseIntPipe) gameId: number) {
//     try {
//       const result = await this.scheduleService.deleteSchedule(gameId);
//       return { statusCode: HttpStatus.OK, ...result };
//     } catch (e: any) {
//       throw new HttpException(
//         { statusCode: e?.status || 500, message: e?.message || 'Error' },
//         e?.status || 500,
//       );
//     }
//   }

//   // POST /games/admin/:gameId/schedule/toggle
//   @UseGuards(AdminGuard)
//   @Post('admin/:gameId/schedule/toggle')
//   async toggleSchedule(@Param('gameId', ParseIntPipe) gameId: number) {
//     try {
//       const data = await this.scheduleService.toggleSchedule(gameId);
//       return {
//         statusCode: HttpStatus.OK,
//         message: data.is_active ? 'Schedule activated' : 'Schedule paused',
//         data,
//       };
//     } catch (e: any) {
//       throw new HttpException(
//         { statusCode: e?.status || 500, message: e?.message || 'Error' },
//         e?.status || 500,
//       );
//     }
//   }

//   // ╔═══════════════════════════════════════════════════════╗
//   // ║  POST /games/bet-with-ticket  (places bet + PDF)      ║
//   // ╚═══════════════════════════════════════════════════════╝
//   //
//   // Body (same shape your existing placeBet expects):
//   //   { game_id, round_id, bet_number, amount }
//   //   user_id is forced from the JWT below — body value is ignored.
//   //
//   // Response adds: ticketUrl: "/tickets/BET-xxx.pdf" (null if PDF failed)

//   @UseGuards(JwtAuthGuard)
//   @Post('bet-with-ticket')
//   async placeBetWithTicket(@Body() body: any, @Req() req: any) {
//     try {
//       // Force user_id from JWT — never trust the body for auth.
//       body.user_id = req.user.sub;

//       // 1. Place the bet (existing logic, full transaction unchanged).
//       const bet = await this.gameService.placeBet(body);

//       // 2. Fetch extra data for the ticket.
//       const [userRows, gameRows, roundRows] = await Promise.all([
//         this.dataSource.query(
//           `SELECT id, full_name, username FROM users WHERE id = $1`,
//           [body.user_id],
//         ),
//         this.dataSource.query(
//           `SELECT id, name, digit_length FROM games WHERE id = $1`,
//           [body.game_id],
//         ),
//         this.dataSource.query(
//           `SELECT id, round_code FROM game_rounds WHERE id = $1`,
//           [body.round_id],
//         ),
//       ]);

//       // 3. Generate PDF → upload to S3 → save URL to bets.ticket_url
//       // Non-blocking: PDF failure does NOT undo the bet.
//       let ticketUrl: string | null = null;
//       if (userRows.length && gameRows.length && roundRows.length) {
//         try {
//           ticketUrl = await this.scheduleService.generateBetTicket(
//             bet,
//             userRows[0],
//             gameRows[0],
//             roundRows[0],
//           );
//           // Persist S3 URL on the bet row so it can be retrieved later
//           if (ticketUrl) {
//             await this.dataSource.query(
//               `UPDATE bets SET ticket_url = $1 WHERE id = $2`,
//               [ticketUrl, bet.id],
//             );
//           }
//         } catch (pdfErr) {
//           console.error('PDF generation / S3 upload failed:', pdfErr);
//         }
//       }

//       return {
//         statusCode: HttpStatus.CREATED,
//         message: 'Bet placed successfully',
//         data: bet,
//         ticketUrl,
//         ticketNote: ticketUrl
//           ? 'Your ticket is ready. Open ticketUrl to download.'
//           : 'Ticket generation failed — contact support with your bet code.',
//       };
//     } catch (e: any) {
//       throw new HttpException(
//         {
//           statusCode: e?.status || 500,
//           message: e?.message || 'Failed to place bet',
//           ...(e?.response && typeof e.response === 'object' ? e.response : {}),
//         },
//         e?.status || 500,
//       );
//     }
//   }
// }

// src/game/schedule.controller.ts
//
// Admin endpoints for game_schedules + a bet-with-ticket wrapper.
//
// NOTE: routes live under the same 'games' prefix as GameController.
// Nest allows two controllers sharing a prefix as long as no two
// methods map to the same METHOD+path. All routes here are new.

import {
  Controller, Get, Post, Patch, Delete, Body, Param, Req,
  HttpStatus, HttpException, ParseIntPipe,
  UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { ScheduleService } from './schedule.service';
import { GameService } from './game.service';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { DataSource } from 'typeorm';

@Controller('games')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class ScheduleController {
  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly gameService: GameService,
    private readonly dataSource: DataSource,
  ) {}

  // ╔═══════════════════════════════════════════════════════╗
  // ║  SCHEDULE CRUD  (admin only)                          ║
  // ╚═══════════════════════════════════════════════════════╝

  // GET /games/admin/schedules
  @UseGuards(AdminGuard)
  @Get('admin/schedules')
  async listSchedules() {
    try {
      const data = await this.scheduleService.listSchedules();
      return { statusCode: HttpStatus.OK, message: 'Schedules', count: data.length, data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // GET /games/admin/scheduler/health
  //   Static route — declared before admin/:gameId/schedule so it is not
  //   captured by the :gameId param route.
  @UseGuards(AdminGuard)
  @Get('admin/scheduler/health')
  async schedulerHealth() {
    try {
      const data = await this.scheduleService.schedulerHealth();
      return { statusCode: HttpStatus.OK, message: 'Scheduler health', data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // GET /games/admin/:gameId/schedule
  @UseGuards(AdminGuard)
  @Get('admin/:gameId/schedule')
  async getSchedule(@Param('gameId', ParseIntPipe) gameId: number) {
    try {
      const data = await this.scheduleService.getSchedule(gameId);
      return { statusCode: HttpStatus.OK, message: 'Schedule', data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // POST /games/admin/:gameId/schedule
  @UseGuards(AdminGuard)
  @Post('admin/:gameId/schedule')
  async createSchedule(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Body() dto: CreateScheduleDto,
    @Req() req: any,
  ) {
    try {
      const data = await this.scheduleService.createSchedule(gameId, dto, req.user?.sub);
      return { statusCode: HttpStatus.CREATED, message: 'Schedule created', data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // PATCH /games/admin/:gameId/schedule
  @UseGuards(AdminGuard)
  @Patch('admin/:gameId/schedule')
  async updateSchedule(
    @Param('gameId', ParseIntPipe) gameId: number,
    @Body() dto: UpdateScheduleDto,
  ) {
    try {
      const data = await this.scheduleService.updateSchedule(gameId, dto);
      return { statusCode: HttpStatus.OK, message: 'Schedule updated', data };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // DELETE /games/admin/:gameId/schedule
  @UseGuards(AdminGuard)
  @Delete('admin/:gameId/schedule')
  async deleteSchedule(@Param('gameId', ParseIntPipe) gameId: number) {
    try {
      const result = await this.scheduleService.deleteSchedule(gameId);
      return { statusCode: HttpStatus.OK, ...result };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // POST /games/admin/:gameId/schedule/toggle
  @UseGuards(AdminGuard)
  @Post('admin/:gameId/schedule/toggle')
  async toggleSchedule(@Param('gameId', ParseIntPipe) gameId: number) {
    try {
      const data = await this.scheduleService.toggleSchedule(gameId);
      return {
        statusCode: HttpStatus.OK,
        message: data.is_active ? 'Schedule activated' : 'Schedule paused',
        data,
      };
    } catch (e: any) {
      throw new HttpException(
        { statusCode: e?.status || 500, message: e?.message || 'Error' },
        e?.status || 500,
      );
    }
  }

  // ╔═══════════════════════════════════════════════════════╗
  // ║  POST /games/bet-with-ticket  (places bet + PDF)      ║
  // ╚═══════════════════════════════════════════════════════╝
  //
  // Body (same shape your existing placeBet expects):
  //   { game_id, round_id, bet_number, amount }
  //   user_id is forced from the JWT below — body value is ignored.
  //
  // Response adds: ticketUrl: "/tickets/BET-xxx.pdf" (null if PDF failed)

  @UseGuards(JwtAuthGuard)
  @Post('bet-with-ticket')
  async placeBetWithTicket(@Body() body: any, @Req() req: any) {
    try {
      // Force user_id from JWT — never trust the body for auth.
      body.user_id = req.user.sub;

      // 1. Place the bet (existing logic, full transaction unchanged).
      const bet = await this.gameService.placeBet(body);

      // 2. Fetch extra data for the ticket.
      const [userRows, gameRows, roundRows] = await Promise.all([
        this.dataSource.query(
          `SELECT id, full_name, username FROM users WHERE id = $1`,
          [body.user_id],
        ),
        this.dataSource.query(
          `SELECT id, name, digit_length FROM games WHERE id = $1`,
          [body.game_id],
        ),
        this.dataSource.query(
          `SELECT id, round_code FROM game_rounds WHERE id = $1`,
          [body.round_id],
        ),
      ]);

      // 3. Generate PDF → upload to S3 → save URL to bets.ticket_url
      // Non-blocking: PDF failure does NOT undo the bet.
      let ticketUrl: string | null = null;
      if (userRows.length && gameRows.length && roundRows.length) {
        try {
          ticketUrl = await this.scheduleService.generateBetTicket(
            bet,
            userRows[0],
            gameRows[0],
            roundRows[0],
          );
          // Persist S3 URL on the bet row so it can be retrieved later
          if (ticketUrl) {
            await this.dataSource.query(
              `UPDATE bets SET ticket_url = $1 WHERE id = $2`,
              [ticketUrl, bet.id],
            );
          }
        } catch (pdfErr) {
          console.error('PDF generation / S3 upload failed:', (pdfErr as any)?.message, pdfErr);
        }
      }

      return {
        statusCode: HttpStatus.CREATED,
        message: 'Bet placed successfully',
        data: bet,
        ticketUrl,
        ticketNote: ticketUrl
          ? 'Your ticket is ready. Open ticketUrl to download.'
          : 'Ticket generation failed — contact support with your bet code.',
      };
    } catch (e: any) {
      throw new HttpException(
        {
          statusCode: e?.status || 500,
          message: e?.message || 'Failed to place bet',
          ...(e?.response && typeof e.response === 'object' ? e.response : {}),
        },
        e?.status || 500,
      );
    }
  }
}