// src/game/games.gateway.ts
//
// Public WebSocket gateway for game events.
//
// CONNECTION URL: ws://your-server:3000/ws/games
//
// CLIENT FLOW (no auth required for these public events):
//
//   const socket = io('http://localhost:3000/ws/games');
//   socket.on('connect', () => {
//     socket.emit('subscribe-game', { gameId: 1 });
//   });
//   socket.on('round:opened',           data => { ... });
//   socket.on('round:closing-soon',     data => { ... });
//   socket.on('round:closed',           data => { ... });
//   socket.on('round:result-published', data => { ... });
//   socket.on('round:settled',          data => { ... });
//   socket.on('subscribed',             data => { /* ack */ });
//
// EVENT EMISSION (server-side):
//   The GameService, RoundSchedulerService and RoundWatcherService call
//   these methods after their DB operations succeed. Each broadcasts to a
//   room named `game:<gameId>` so only subscribers of that game get it.

import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  namespace: '/ws/games',
  cors: {
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://15.207.97.72:5173',
      'http://15.207.97.72:4173',
    ],
    credentials: true,
  },
})
export class GamesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GamesGateway.name);

  @WebSocketServer()
  server!: Server;

  // ─── LIFECYCLE ───────────────────────────────────────────────

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    client.emit('connected', {
      message: 'Connected to games gateway',
      socketId: client.id,
      serverTime: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ─── CLIENT-DRIVEN: SUBSCRIBE TO A GAME ──────────────────────
  @SubscribeMessage('subscribe-game')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { gameId: number },
  ) {
    const gameId = Number(body?.gameId);
    if (!Number.isFinite(gameId) || gameId <= 0) {
      client.emit('error', { event: 'subscribe-game', message: 'invalid gameId' });
      return;
    }
    const room = `game:${gameId}`;
    client.join(room);
    client.emit('subscribed', { gameId, room });
  }

  @SubscribeMessage('unsubscribe-game')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { gameId: number },
  ) {
    const gameId = Number(body?.gameId);
    if (!Number.isFinite(gameId)) {
      client.emit('error', { event: 'unsubscribe-game', message: 'invalid gameId' });
      return;
    }
    const room = `game:${gameId}`;
    client.leave(room);
    client.emit('unsubscribed', { gameId, room });
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { serverTime: new Date().toISOString() });
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║          SERVER-SIDE EMITTERS                             ║
  // ╚═══════════════════════════════════════════════════════════╝

  /**
   * Round opened. Fired by admin createRound AND by RoundSchedulerService
   * for auto-spawned rounds.
   */
  emitRoundOpened(payload: {
    gameId: number;
    roundId: number;
    roundCode: string;
    openTime: Date | string;
    closeTime: Date | string;
    drawTime: Date | string;
  }) {
    const room = `game:${payload.gameId}`;
    this.server.to(room).emit('round:opened', {
      ...payload,
      announcedAt: new Date().toISOString(),
    });
    this.logger.debug(`Emitted round:opened to ${room} (round ${payload.roundId})`);
  }

  /**
   * Round closing soon (T-30s). Fired by RoundWatcherService.
   */
  emitRoundClosingSoon(payload: {
    gameId: number;
    roundId: number;
    secondsUntilClose: number;
  }) {
    const room = `game:${payload.gameId}`;
    this.server.to(room).emit('round:closing-soon', {
      ...payload,
      announcedAt: new Date().toISOString(),
    });
  }

  /**
   * Round closed (close_time hit). Fired by RoundWatcherService.
   *
   * BACKWARD COMPATIBLE: roundCode and drawTime are OPTIONAL. The existing
   * RoundWatcherService calls this with { gameId, roundId, closeTime }, which
   * still works. New callers may also pass roundCode/drawTime.
   */
  emitRoundClosed(payload: {
    gameId: number;
    roundId: number;
    closeTime?: Date | string;
    roundCode?: string;
    drawTime?: Date | string;
  }) {
    const room = `game:${payload.gameId}`;
    this.server.to(room).emit('round:closed', {
      ...payload,
      announcedAt: new Date().toISOString(),
    });
    this.logger.debug(`Emitted round:closed to ${room} (round ${payload.roundId})`);
  }

  /**
   * Result published — the winning number.
   */
  emitResultPublished(payload: {
    gameId: number;
    roundId: number;
    resultNumber: string;
  }) {
    const room = `game:${payload.gameId}`;
    this.server.to(room).emit('round:result-published', {
      ...payload,
      announcedAt: new Date().toISOString(),
    });
    this.logger.log(
      `Emitted round:result-published to ${room} (round ${payload.roundId} = ${payload.resultNumber})`,
    );
  }

  /**
   * Round settled — all bets paid out / closed.
   */
  emitRoundSettled(payload: {
    gameId: number;
    roundId: number;
    betsSettled: number;
    winners: number;
    losers: number;
  }) {
    const room = `game:${payload.gameId}`;
    this.server.to(room).emit('round:settled', {
      ...payload,
      announcedAt: new Date().toISOString(),
    });
  }
}