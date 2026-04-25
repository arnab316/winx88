import { Module } from '@nestjs/common';
import { TurnoverService } from './turnover.service';
import { TurnoverController } from './turnover.controller';

@Module({
  providers: [TurnoverService],
  controllers: [TurnoverController],
  exports: [TurnoverService]
})
export class TurnoverModule {}
