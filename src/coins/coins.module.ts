import { Module } from '@nestjs/common';
import { CoinsService } from './coins.service';
import { CoinsController } from './coins.controller';
import { AuthModule } from 'src/auth/auth.module';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AdminGuard } from 'src/common/guards/admin.guard';

@Module({
  imports: [AuthModule],
  providers: [CoinsService,JwtAuthGuard,AdminGuard],
  controllers: [CoinsController],
    exports: [CoinsService], 
})
export class CoinsModule {}
