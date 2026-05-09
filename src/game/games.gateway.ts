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
//   This gateway exposes 5 public methods that the GameService calls
//   after relevant DB operations succeed. Each broadcasts to a room
//   named `game:<gameId>` so only subscribers of that game get it.
//
// AUTH NOTE:
//   This gateway is currently public — anyone can connect and subscribe.
//   When you later add user-specific events (wallet credits, etc.), you'll
//   create a separate authenticated gateway at a different namespace
//   (e.g. /ws/me) that uses the JWT in the handshake.

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
    // Match your HTTP CORS origins. Adjust if needed.
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://15.207.97.72:5173',
      'http://15.207.97.72:4173',
    ],
    credentials: true,
  },
  // Transports default to ['polling','websocket']; that's fine for now.
})
export class GamesGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GamesGateway.name);

  @WebSocketServer()
  server!: Server;

  // ─── LIFECYCLE ───────────────────────────────────────────────

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    // Send a hello so the client knows the connection is healthy
    client.emit('connected', {
      message: 'Connected to games gateway',
      socketId: client.id,
      serverTime: new Date().toISOString(),
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Socket.IO auto-cleans rooms on disconnect — no manual cleanup needed
  }

  // ─── CLIENT-DRIVEN: SUBSCRIBE TO A GAME ──────────────────────
  //
  // Client emits: socket.emit('subscribe-game', { gameId: 1 })
  // Server replies with 'subscribed' event.
  //
  // Joining the room `game:<gameId>` means the server will deliver
  // any event we emit to that room to this client. Multiple games?
  // Just call subscribe-game multiple times.
  // ─────────────────────────────────────────────────────────────
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

  // Client emits: socket.emit('unsubscribe-game', { gameId: 1 })
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

  // Client emits: socket.emit('ping') → server replies 'pong' with serverTime
  // Useful for keep-alive and clock-skew detection on the client.
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    client.emit('pong', { serverTime: new Date().toISOString() });
  }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║          SERVER-SIDE EMITTERS (called by GameService)     ║
  // ╚═══════════════════════════════════════════════════════════╝

  /**
   * Round opened. Broadcast when admin creates a new round.
   * Subscribers to `game:<gameId>` see this immediately.
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
   * Round is closing soon. The round-watcher cron fires this
   * at T-30s before close_time. UX-grade signal — frontend can
   * show a "closing soon!" badge.
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
   * Round closed (close_time hit). New bets refused after this point.
   * Frontend should disable the bet button.
   */
  emitRoundClosed(payload: {
    gameId: number;
    roundId: number;
    closeTime: Date | string;
  }) {
    const room = `game:${payload.gameId}`;
    this.server.to(room).emit('round:closed', {
      ...payload,
      announcedAt: new Date().toISOString(),
    });
  }

  /**
   * Result published. Most exciting event for users — the winning number.
   * Frontend shows the result with animation.
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
   * Round settled — all bets paid out / closed. After this fires,
   * stats can refresh, bet history shows WON/LOST.
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