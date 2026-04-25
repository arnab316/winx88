import { forwardRef, Module } from '@nestjs/common';
import { CoinsService } from './coins.service';
import { CoinsController } from './coins.controller';
import { AuthModule } from 'src/auth/auth.module';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { VipModule } from 'src/vip/vip.module';

@Module({
  imports: [AuthModule, 
     forwardRef(() => VipModule),
  ],
  providers: [CoinsService,JwtAuthGuard,AdminGuard],
  controllers: [CoinsController],
    exports: [CoinsService], 
})
export class CoinsModule {}
