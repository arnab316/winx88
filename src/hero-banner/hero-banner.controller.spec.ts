import { Test, TestingModule } from '@nestjs/testing';
import { HeroBannerController } from './hero-banner.controller';

describe('HeroBannerController', () => {
  let controller: HeroBannerController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HeroBannerController],
    }).compile();

    controller = module.get<HeroBannerController>(HeroBannerController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
