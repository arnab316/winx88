import { Module } from '@nestjs/common';
import { JackpotService } from './jackpot.service';
import { JackpotController } from './jackpot.controller';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { AuthModule } from 'src/auth/auth.module';
import { TurnoverModule } from 'src/turnover/turnover.module';

@Module({
  imports: [AuthModule, TurnoverModule],
  providers: [JackpotService, JwtAuthGuard, AdminGuard],
  controllers: [JackpotController],
})
export class JackpotModule {}
