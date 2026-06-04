import { Test, TestingModule } from '@nestjs/testing';
import { PromotionEngineService } from './promotion-engine.service';

describe('PromotionEngineService', () => {
  let service: PromotionEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PromotionEngineService],
    }).compile();

    service = module.get<PromotionEngineService>(PromotionEngineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
