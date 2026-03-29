import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { AuthGateway } from './auth.gateway';

@Module({
  imports: [JwtModule.register({
    secret: 'your-secret-key',})],
  controllers: [AuthController],
  providers: [AuthService, AuthGateway],
  exports: [JwtModule],
})
export class AuthModule {}
