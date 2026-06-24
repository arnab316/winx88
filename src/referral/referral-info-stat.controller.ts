import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { CreateReferralInfoStatDto, UpdateReferralInfoStatDto } from './dto/referral-info-stat.dto';
import { ReferralInfoStatService } from './referral-info-stat.service';

/**
 * CRUD controller for the referral_info_stat table.
 *
 *   POST   /admin/referral-info-stat          → create a record
 *   GET    /admin/referral-info-stat           → list all records
 *   GET    /admin/referral-info-stat/:id       → get one by id
 *   PATCH  /admin/referral-info-stat/:id       → update one by id
 *   DELETE /admin/referral-info-stat/:id       → delete one by id
 */
@Controller('admin/referral-info-stat')
@UseGuards(AdminGuard)
export class ReferralInfoStatController {
  constructor(private readonly statService: ReferralInfoStatService) {}

  @Post()
  async create(@Body() dto: CreateReferralInfoStatDto) {
    return this.wrap(() => this.statService.create(dto), 'Record created successfully');
  }

  @Get()
  async findAll() {
    return this.wrap(() => this.statService.findAll(), 'Records fetched successfully');
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.wrap(() => this.statService.findOne(id), 'Record fetched successfully');
  }

  @Patch(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateReferralInfoStatDto,
  ) {
    return this.wrap(() => this.statService.update(id, dto), 'Record updated successfully');
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    return this.wrap(() => this.statService.remove(id), 'Record deleted successfully');
  }

  private async wrap<T>(fn: () => Promise<T>, message: string) {
    try {
      return { success: true, message, data: await fn() };
    } catch (e: any) {
      throw new HttpException(
        { success: false, message: e?.message || 'An error occurred', data: null },
        e?.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
