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
 *   GET /admin/catalog/providers?category=   → providers, all integrations
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

  /**
   * Every provider an admin can target or exclude, across all integrations.
   * `category` narrows it to the providers offering one vertical, which is
   * what the promotion form asks for when a vertical is expanded.
   */
  @Get('providers')
  getProviders(@Query('category') category?: string) {
    return this.catalog.getProviders(category);
  }

  @Get('games')
  getGames(
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('provider') provider?: string,
    @Query('limit', new DefaultValuePipe(200), ParseIntPipe) limit?: number,
  ) {
    return this.catalog.getGames({ search, source, provider, limit });
  }
}
