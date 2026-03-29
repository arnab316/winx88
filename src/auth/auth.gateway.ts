import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
} from '@nestjs/websockets';
import { AuthService } from './auth.service';
import { Socket } from 'socket.io';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class AuthGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private authService: AuthService) {}

  handleConnection(@ConnectedSocket() client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('checkUsername')
  async handleCheckUsername(@MessageBody() username: string,
  @ConnectedSocket() client: Socket,
) {
    if (!username || username.length < 3) {
      client.emit('usernameResult', {
        username,
        available: false,
        message: 'Too short',
      });
      return;
    }

    const isTaken = await this.authService.isUsernameTaken(username);

     client.emit('usernameResult', {
      username,
      available: !isTaken,
    });
  }
}