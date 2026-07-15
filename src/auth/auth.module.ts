import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtModule } from '@nestjs/jwt';
import { AuthGateway } from './auth.gateway';
import { TwilioService } from 'src/twilio/twilio.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { PromotionModule } from '../promotion/promotion.module';
import { OtpCleanupService } from './otpcleanup';
import { LoggerModule } from 'src/logger/logger.module';
import { LaafficService } from 'src/laaffic/laaffic.service';

@Module({
  imports: [JwtModule.register({
    secret: 'your-secret-key',}), PromotionModule, LoggerModule],
  controllers: [AuthController],
  providers: [AuthService, AuthGateway, TwilioService, JwtAuthGuard, OtpCleanupService, LaafficService],
  exports: [JwtModule, AuthService],
})
export class AuthModule {}
