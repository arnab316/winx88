import { Test, TestingModule } from '@nestjs/testing';
import { PromotionCmsController } from './promotion-cms.controller';

describe('PromotionCmsController', () => {
  let controller: PromotionCmsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PromotionCmsController],
    }).compile();

    controller = module.get<PromotionCmsController>(PromotionCmsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
