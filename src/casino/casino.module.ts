import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CasinoController } from './casino.controller';
import { CasinoService } from './casino.service';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [
    HttpModule,
    WalletModule,
  ],
  controllers: [CasinoController],
  providers: [CasinoService],
})
export class CasinoModule {}
