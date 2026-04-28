import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { AuthGateway } from './auth.gateway';
import { TwilioService } from 'src/twilio/twilio.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { PromotionModule } from '../promotion/promotion.module';
@Module({
  imports: [JwtModule.register({
    secret: 'your-secret-key',}), PromotionModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGateway, TwilioService, JwtAuthGuard],
  exports: [JwtModule],
})
export class AuthModule {}
