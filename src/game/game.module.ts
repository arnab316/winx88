import { Module } from '@nestjs/common';
import { GameService } from './game.service';
import { GameController } from './game.controller';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { GameValidationService } from './game-validation.service';
import { TurnoverModule } from 'src/turnover/turnover.module';
import { AuthModule } from 'src/auth/auth.module';
import { TurnoverService } from 'src/turnover/turnover.service';

@Module({
     imports: [AuthModule, TurnoverModule],
    providers: [
    GameService,
    GameValidationService,                                            // ← ADD
    JwtAuthGuard,
    TurnoverService
  ],
  controllers: [GameController],
   exports: [GameValidationService],
})
export class GameModule {}
