import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
} from '@nestjs/websockets';
import { AuthService } from './auth.service';

@WebSocketGateway({
  cors: { origin: '*' },
})
export class AuthGateway {
  constructor(private authService: AuthService) {
  }

  @SubscribeMessage('checkUsername')
  async handleCheckUsername(@MessageBody() username: string) {
    if (!username || username.length < 3) {
      return {
        event: 'usernameResult',
        data: {
          available: false,
          message: 'Too short',
        },
      };
    }

    const isTaken = await this.authService.isUsernameTaken(username);

    return {
      event: 'usernameResult',
      data: {
        username,
        available: !isTaken,
      },
    };
  }
}