import { Test, TestingModule } from '@nestjs/testing';
import { TurnoverController } from './turnover.controller';

describe('TurnoverController', () => {
  let controller: TurnoverController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TurnoverController],
    }).compile();

    controller = module.get<TurnoverController>(TurnoverController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
