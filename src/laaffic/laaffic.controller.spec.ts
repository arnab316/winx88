import { Test, TestingModule } from '@nestjs/testing';
import { LaafficController } from './laaffic.controller';

describe('LaafficController', () => {
  let controller: LaafficController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LaafficController],
    }).compile();

    controller = module.get<LaafficController>(LaafficController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
