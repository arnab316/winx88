import {
  Controller,
  Get,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
} from '@nestjs/common';
import { AdminGuard } from 'src/common/guards/admin.guard';
import { CatalogService } from './catalog.service';

/**
 * Read-only lookup data for admin forms (promotion provider checkboxes +
 * exclude game list). Admin-only.
 *
 *   GET /admin/catalog                       → { categories, games }
 *   GET /admin/catalog/categories            → provider verticals
 *   GET /admin/catalog/games?search=&source= → games for the exclude list
 *        source = OWN | PALACE | OROPLAY (omit for all)
 */
@Controller('admin/catalog')
@UseGuards(AdminGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  getAll(@Query('search') search?: string) {
    return this.catalog.getAll(search);
  }

  @Get('categories')
  getCategories() {
    return this.catalog.getCategories();
  }

  @Get('games')
  getGames(
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit?: number,
  ) {
    return this.catalog.getGames({ search, source, limit });
  }
}
