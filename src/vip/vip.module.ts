import { Module, forwardRef } from '@nestjs/common';
import { VipController } from './vip.controller';
import { TierController } from './tier.controller';
import { VipService } from './vip.service';
import { AuthModule } from 'src/auth/auth.module';
import { WalletModule } from 'src/wallet/wallet.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Module({
  // Reuse AuthModule's JwtModule (single JWT config / secret) instead of
  // registering our own from process.env, which is undefined at module-load
  // time and caused "Invalid or expired token" on every VIP admin route.
  // WalletModule (forwardRef — Vip→Wallet→Coins→Vip cycle) provides
  // WalletGateway for live banking-toggle pushes.
  imports: [AuthModule, forwardRef(() => WalletModule)],
  controllers: [VipController, TierController],
  providers: [VipService, JwtAuthGuard, AdminGuard],
  exports: [VipService],
})
export class VipModule {}
