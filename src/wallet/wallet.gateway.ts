// src/wallet/wallet.gateway.ts
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { WalletService } from './wallet.service';
import { Logger , Inject, forwardRef} from '@nestjs/common';

@WebSocketGateway({
  namespace: '/wallet',       // ws://yourhost/wallet
  cors: { origin: '*' },     // tighten in production
})
export class WalletGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(WalletGateway.name);

  // userId → Set of socket ids (one user can have multiple tabs/devices)
  private userSockets = new Map<number, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
   @Inject(forwardRef(() => WalletService)) 
    private readonly walletService: WalletService,
  ) {}

  // ═════════════════════════════════════════════════════════════
  // CONNECTION — validate JWT from handshake, register socket
  // ═════════════════════════════════════════════════════════════
  async handleConnection(client: Socket) {
    try {
      // Client must send token in handshake:
      //   socket = io('/wallet', { auth: { token: 'Bearer eyJ...' } })
      const raw =
        (client.handshake.auth?.token as string) ||
        (client.handshake.headers?.authorization as string);

      if (!raw) throw new Error('No token');

      const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
      const payload = this.jwtService.verify(token) as { sub: number };
      const userId = Number(payload.sub);

      // Store userId on socket for later use
      (client as any).userId = userId;

      // Register socket under this user
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(client.id);

      // Join a room named after the user so we can push to them later
      client.join(`user:${userId}`);

      this.logger.log(`WS connected: userId=${userId} socketId=${client.id}`);

      // Immediately send current balance on connect
      const wallet = await this.walletService.getWallet(userId);
      client.emit('wallet:balance', wallet);

      // Join the VIP-tier room so admin banking-toggle changes can be pushed
      // to everyone at that level ('banking:toggles' events). A user who
      // levels up mid-session re-joins the right room on their next connect.
      client.join(`tier:${Number(wallet?.vipLevel ?? 0)}`);
    } catch (err: any) {
      this.logger.warn(`WS rejected: ${err.message} socketId=${client.id}`);
      client.emit('wallet:error', { message: 'Unauthorized' });
      client.disconnect();
    }
  }

  // ═════════════════════════════════════════════════════════════
  // DISCONNECTION — clean up socket registry
  // ═════════════════════════════════════════════════════════════
  handleDisconnect(client: Socket) {
    const userId = (client as any).userId as number | undefined;
    if (userId) {
      const sockets = this.userSockets.get(userId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) this.userSockets.delete(userId);
      }
    }
    this.logger.log(`WS disconnected: socketId=${client.id}`);
  }

  // ═════════════════════════════════════════════════════════════
  // EVENT: wallet:refresh — client asks for latest balance
  // ═════════════════════════════════════════════════════════════
  @SubscribeMessage('wallet:refresh')
  async handleRefresh(@ConnectedSocket() client: Socket) {
    const userId = (client as any).userId as number;
    if (!userId) {
      client.emit('wallet:error', { message: 'Unauthorized' });
      return;
    }

    try {
      this.logger.log(`wallet:refresh requested by userId=${userId}`);
      const wallet = await this.walletService.getWallet(userId);
      client.emit('wallet:balance', wallet);
    } catch (err: any) {
      this.logger.error(`wallet:refresh failed for userId=${userId}: ${err.message}`);
      client.emit('wallet:error', { message: 'Failed to fetch balance' });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC METHOD — called by WalletService after any balance change
  //   e.g. deposit approved, withdrawal, bet placed, manual adjust
  //   pushes updated wallet to all sockets of that user
  // ═════════════════════════════════════════════════════════════
  async pushBalanceUpdate(userId: number) {
    try {
      const wallet = await this.walletService.getWallet(userId);
      this.server.to(`user:${userId}`).emit('wallet:balance', wallet);
      this.logger.log(`wallet:balance pushed to userId=${userId}`);
    } catch (err: any) {
      this.logger.error(`pushBalanceUpdate failed for userId=${userId}: ${err.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PUBLIC METHOD — called by VipService after an admin flips the
  //   per-tier banking toggles. Pushes the fresh effective toggle
  //   state to every connected user of that VIP level, so open
  //   deposit/withdraw pages re-render without a refresh.
  // ═════════════════════════════════════════════════════════════
  pushBankingToggles(level: number, toggles: unknown) {
    try {
      this.server.to(`tier:${level}`).emit('banking:toggles', toggles);
      this.logger.log(`banking:toggles pushed to tier:${level}`);
    } catch (err: any) {
      this.logger.error(`pushBankingToggles failed for level=${level}: ${err.message}`);
    }
  }
}