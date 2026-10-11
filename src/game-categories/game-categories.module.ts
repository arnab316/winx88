import { Module } from '@nestjs/common';

import { AuthModule } from 'src/auth/auth.module';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { GameCategoriesController } from './game-categories.controller';
import { GameCategoriesService } from './game-categories.service';

/** Admin-managed category chips on the player home screen. */
@Module({
  imports: [AuthModule],
  controllers: [GameCategoriesController],
  providers: [GameCategoriesService, AdminGuard],
  exports: [GameCategoriesService],
})
export class GameCategoriesModule {}
