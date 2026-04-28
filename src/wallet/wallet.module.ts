import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthModule } from 'src/auth/auth.module';
import { S3Service } from './s3.service';
import { MulterModule } from '@nestjs/platform-express';
import { CoinsModule } from 'src/coins/coins.module';
import { GameModule } from 'src/game/game.module';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { PromotionModule } from 'src/promotion/promotion.module';

@Module({
  imports: [MulterModule.register({}), AuthModule, CoinsModule, TurnoverModule,
    GameModule,PromotionModule],
  controllers: [WalletController],
  providers: [WalletService, S3Service, JwtAuthGuard,TurnoverModule],
  exports: [JwtAuthGuard],
})
export class WalletModule { }
