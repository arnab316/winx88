import { Test, TestingModule } from '@nestjs/testing';
import { PromotionStatsController } from './promotion-stats.controller';

describe('PromotionStatsController', () => {
  let controller: PromotionStatsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PromotionStatsController],
    }).compile();

    controller = module.get<PromotionStatsController>(PromotionStatsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
