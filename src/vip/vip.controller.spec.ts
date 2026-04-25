import { Test, TestingModule } from '@nestjs/testing';
import { VipController } from './vip.controller';

describe('VipController', () => {
  let controller: VipController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VipController],
    }).compile();

    controller = module.get<VipController>(VipController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
