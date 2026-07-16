// import { Module } from '@nestjs/common';
// import { WalletController } from './wallet.controller';
// import { WalletService } from './wallet.service';
// import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
// import { AuthModule } from 'src/auth/auth.module';
// import { S3Service } from './s3.service';
// import { MulterModule } from '@nestjs/platform-express';
// import { CoinsModule } from 'src/coins/coins.module';
// import { GameModule } from 'src/game/game.module';
// import { TurnoverModule } from 'src/turnover/turnover.module';
// import { PromotionModule } from 'src/promotion/promotion.module';
// import { WalletGateway } from './wallet.gateway';

// @Module({
//   imports: [MulterModule.register({}), AuthModule, CoinsModule, TurnoverModule,
//     GameModule,PromotionModule],
//   controllers: [WalletController],
//   providers: [WalletService, S3Service, JwtAuthGuard,TurnoverModule,WalletGateway],
//   exports: [JwtAuthGuard, WalletGateway],
// })
// export class WalletModule { }


import { Module, forwardRef } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WalletGateway } from './wallet.gateway';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthModule } from 'src/auth/auth.module';
import { S3Service } from './s3.service';
import { MulterModule } from '@nestjs/platform-express';
import { CoinsModule } from 'src/coins/coins.module';
import { GameModule } from 'src/game/game.module';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { PromotionModule } from 'src/promotion/promotion.module';

@Module({
  imports: [
    MulterModule.register({}),
    AuthModule,
    // forwardRef: part of the Vip→Wallet→Coins→Vip module cycle
    // (VipModule imports WalletModule for banking-toggle socket pushes).
    forwardRef(() => CoinsModule),
    TurnoverModule,
    GameModule,
    PromotionModule,
  ],
  controllers: [WalletController],
  providers: [
    WalletService,   // ← only once, no need for the provide/useClass wrapper
    WalletGateway,
    S3Service,
    JwtAuthGuard,
    // TurnoverModule was here by mistake — modules never go in providers
  ],
  exports: [
    JwtAuthGuard,
    WalletGateway,
    WalletService,   // ← export service too so other modules can call pushBalanceUpdate
  ],
})
export class WalletModule {}