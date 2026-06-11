import { ScheduleModule } from '@nestjs/schedule';
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { LoggerModule } from './logger/logger.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletModule } from './wallet/wallet.module';
import { UserModule } from './user/user.module';
import { GameModule } from './game/game.module';
import { GameHistoryModule } from './game-history/game-history.module';
import { TwilioModule } from './twilio/twilio.module';
import { CoinsModule } from './coins/coins.module';
import { AffiliateModule } from './affiliate/affiliate.module';
import { OtpCleanupService } from './auth/otpcleanup';
import { AgentsModule } from './agents/agents.module';
import { LedgerModule } from './ledger/ledger.module';
import { VipModule } from './vip/vip.module';
import { TurnoverModule } from './turnover/turnover.module';
import { MemberGroupModule } from './member-group/member-group.module';
import { PromotionModule } from './promotion/promotion.module';
import { PromotionCmsModule } from './promotion-cms/promotion-cms.module';
import { JackpotModule } from './jackpot/jackpot.module';
import { AdminModule } from './admin/admin.module';
import { HeroBannerModule } from './hero-banner/hero-banner.module';
import { PalaceCasinoModule } from './palace-casino/palace-casino.module';
import { OroplayModule } from './oroplay/oroplay.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { TicketModule } from './ticket/ticket.module';
import { VerificationModule } from './verification/verification.module';
import { LaafficModule } from './laaffic/laaffic.module';
import { PromotionStatsModule } from './promotion-stats/promotion-stats.module';
import { ReportsModule } from './reports/reports.module';
import { AnnouncementModule } from './announcement/announcement.module';
import { SportsModule } from './sports/sports.module';
import { CatalogModule } from './catalog/catalog.module';
@Module({
  imports: [
    ServeStaticModule.forRoot({
  rootPath: join(process.cwd(), 'public'),
  serveRoot: '/',
  serveStaticOptions: { index: false, dotfiles: 'deny' },
}),
     ScheduleModule.forRoot(),
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule,
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
    GameHistoryModule,
    TwilioModule,
    CoinsModule,
    AffiliateModule,
    AgentsModule,
    LedgerModule,
    VipModule,
    TurnoverModule,
    MemberGroupModule,
    PromotionModule,
    PromotionCmsModule,
    JackpotModule,
    AdminModule,
    HeroBannerModule,
  PalaceCasinoModule,
  OroplayModule,
  TicketModule,
  VerificationModule,
  LaafficModule,
  PromotionStatsModule,
  ReportsModule,
  AnnouncementModule,
  SportsModule,
  CatalogModule,
  ],
  controllers: [AppController],
  providers: [AppService, OtpCleanupService],
})
export class AppModule {}
