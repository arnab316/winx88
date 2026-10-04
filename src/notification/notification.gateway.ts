// src/notification/notification.gateway.ts
import {
  WebSocketGateway, WebSocketServer,
  OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, ConnectedSocket, MessageBody,
} from '@nestjs/websockets';
import { Logger, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Server, Socket } from 'socket.io';

/**
 * Real-time delivery for the notification inbox.
 *
 * The socket is the FAST PATH, never the source of truth — every notification
 * is a row in `notifications` before it is ever emitted. A player who is
 * offline, backgrounded or in a tunnel simply picks it up from the inbox on
 * their next connect, so a dropped socket can never lose a notification.
 *
 * `connectionStateRecovery` covers the short gaps for free: socket.io replays
 * frames missed during a disconnect under two minutes, which handles lifts and
 * tunnels without a round-trip to the database.
 *
 * Auth mirrors WalletGateway — the JWT arrives in the handshake:
 *   io('/notifications', { auth: { token: 'Bearer eyJ...' } })
 */
@Injectable()
@WebSocketGateway({
  namespace: '/notifications',
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
  cors: { origin: '*' },
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(NotificationGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** One room per player — survives multiple tabs and devices for free. */
  private static room(userId: number | string) {
    return `user:${userId}`;
  }

  async handleConnection(client: Socket) {
    try {
      const raw =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string);
      if (!raw) throw new Error('No token');

      const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
      const payload = this.jwtService.verify(token) as {
        sub: number; type?: string; role?: string;
      };

      // Admins have ids in admin_users, not users — they must never land in a
      // player room and start receiving another account's notifications.
      const isAdmin =
        payload.type === 'ADMIN' || (payload.role && payload.role !== 'USER');
      if (isAdmin) {
        client.join('admins');
        client.emit('notifications:connected', { ok: true, scope: 'admin' });
        return;
      }

      const userId = Number(payload.sub);
      (client as any).userId = userId;
      client.join(NotificationGateway.room(userId));

      // The client answers this by calling GET /notifications?sinceId=<its own
      // highest id>. Telling it the current unread count up front means the
      // bell badge is correct before that request even lands.
      const [row] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS unread
           FROM notifications
          WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
      );
      client.emit('notifications:connected', {
        ok: true,
        unread: row?.unread ?? 0,
        // `recovered` is true when socket.io replayed the gap itself, so the
        // client can skip the catch-up fetch.
        recovered: client.recovered === true,
      });
    } catch (e: any) {
      this.logger.warn(`WS notification auth failed: ${e?.message}`);
      client.emit('notifications:error', { message: 'Unauthorized' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = (client as any).userId;
    if (userId) this.logger.debug(`WS notifications disconnect user=${userId}`);
  }

  /**
   * Client confirms it rendered the notification. Only then is it marked
   * delivered — anything unacked stays pending and is picked up by the next
   * catch-up fetch.
   */
  @SubscribeMessage('notification:ack')
  async ack(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { id?: number },
  ) {
    const userId = (client as any).userId;
    if (!userId || !data?.id) return { ok: false };

    await this.dataSource.query(
      `UPDATE notifications
          SET delivered_at = COALESCE(delivered_at, NOW())
        WHERE id = $1 AND user_id = $2`,
      [data.id, userId],
    );
    return { ok: true };
  }

  /** Push one notification to every device this player has open. */
  emitToUser(userId: number, notification: any) {
    this.server
      ?.to(NotificationGateway.room(userId))
      .emit('notification:new', notification);
  }

  /** Badge-only update, e.g. after the player reads something on another tab. */
  emitUnreadCount(userId: number, unread: number) {
    this.server
      ?.to(NotificationGateway.room(userId))
      .emit('notification:unread', { unread });
  }
}
