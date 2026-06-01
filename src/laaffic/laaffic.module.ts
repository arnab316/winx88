import { Module } from '@nestjs/common';
import { LaafficService } from './laaffic.service';
import { LaafficController } from './laaffic.controller';
import { LaafficWebhookController } from './laaffic.webhook.controller';

@Module({
  providers: [LaafficService],
  controllers: [LaafficController,LaafficWebhookController]
})
export class LaafficModule {}
