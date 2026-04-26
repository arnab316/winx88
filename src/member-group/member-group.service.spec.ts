import { Test, TestingModule } from '@nestjs/testing';
import { MemberGroupService } from './member-group.service';

describe('MemberGroupService', () => {
  let service: MemberGroupService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MemberGroupService],
    }).compile();

    service = module.get<MemberGroupService>(MemberGroupService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
