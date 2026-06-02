import { Test, TestingModule } from '@nestjs/testing';
import { PromotionStatsService } from './promotion-stats.service';

describe('PromotionStatsService', () => {
  let service: PromotionStatsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PromotionStatsService],
    }).compile();

    service = module.get<PromotionStatsService>(PromotionStatsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
