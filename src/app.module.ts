import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletModule } from './wallet/wallet.module';
import { UserModule } from './user/user.module';
import { GameModule } from './game/game.module';
import { TwilioModule } from './twilio/twilio.module';
import { CoinsModule } from './coins/coins.module';
import { AffiliateModule } from './affiliate/affiliate.module';
import { OtpCleanupService } from './auth/otpcleanup';
import { AgentsModule } from './agents/agents.module';
import { LedgerModule } from './ledger/ledger.module';
import { VipModule } from './vip/vip.module';
import { TurnoverModule } from './turnover/turnover.module';

@Module({
  imports: [
     ConfigModule.forRoot({ isGlobal: true }),
     TerminusModule,
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST')!,
        port: configService.get<number>('DB_PORT')!,
        username: configService.get<string>('DB_USER')!,
        password: configService.get<string>('DB_PASS')!,
        database: configService.get<string>('DB_NAME')!,
        autoLoadEntities: true,
        synchronize: true, // dev only
      }),
    }),
    AuthModule,
    WalletModule,
    UserModule,
    GameModule,
    TwilioModule,
    CoinsModule,
    AffiliateModule,
    AgentsModule,
    LedgerModule,
    VipModule,
    TurnoverModule],
  controllers: [AppController],
  providers: [AppService, OtpCleanupService],
})
export class AppModule {}
