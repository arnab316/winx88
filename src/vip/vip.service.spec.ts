import { Test, TestingModule } from '@nestjs/testing';
import { VipService } from './vip.service';

describe('VipService', () => {
  let service: VipService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VipService],
    }).compile();

    service = module.get<VipService>(VipService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
