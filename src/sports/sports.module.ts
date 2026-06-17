import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SportsController } from './sports.controller';
import { SportsService } from './sports.service';
import { WalletModule } from '../wallet/wallet.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { TurnoverModule } from '../turnover/turnover.module';

@Module({
  imports: [
    HttpModule,
    WalletModule,
    AuthModule,
    TurnoverModule,
  ],
  controllers: [SportsController],
  providers: [SportsService, AdminGuard],
})
export class SportsModule {}
