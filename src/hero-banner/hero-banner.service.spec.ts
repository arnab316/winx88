import { Test, TestingModule } from '@nestjs/testing';
import { HeroBannerService } from './hero-banner.service';

describe('HeroBannerService', () => {
  let service: HeroBannerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [HeroBannerService],
    }).compile();

    service = module.get<HeroBannerService>(HeroBannerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
