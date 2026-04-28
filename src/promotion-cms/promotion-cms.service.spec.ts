import { Test, TestingModule } from '@nestjs/testing';
import { PromotionCmsService } from './promotion-cms.service';

describe('PromotionCmsService', () => {
  let service: PromotionCmsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PromotionCmsService],
    }).compile();

    service = module.get<PromotionCmsService>(PromotionCmsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
