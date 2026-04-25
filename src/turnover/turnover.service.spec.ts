import { Test, TestingModule } from '@nestjs/testing';
import { TurnoverService } from './turnover.service';

describe('TurnoverService', () => {
  let service: TurnoverService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TurnoverService],
    }).compile();

    service = module.get<TurnoverService>(TurnoverService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
