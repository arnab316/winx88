import { Test, TestingModule } from '@nestjs/testing';
import { LaafficService } from './laaffic.service';

describe('LaafficService', () => {
  let service: LaafficService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LaafficService],
    }).compile();

    service = module.get<LaafficService>(LaafficService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
