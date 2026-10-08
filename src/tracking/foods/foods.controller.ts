/**
 * Kal — the tracking foods HTTP surface (wave-03 contract §2 fixture entries;
 * conventions §1 bearer).
 *
 * Route class is bearer-guarded (`RequireIdentityBearer` — the identity wave's
 * JWT→UserContext resolution; 401 UNAUTHENTICATED + `WWW-Authenticate: Bearer`
 * for every failure class). Controllers stay thin: parse nothing, validate
 * nothing — they hand raw parameter values to the service, which owns
 * validation, authorization, and the unit of work (sanctioned path).
 *
 * DIARY MUTATIONS DO NOT EXIST over REST by design (contract §2 freeze) — no
 * POST/PUT/PATCH/DELETE lands on any /diary path in this module; diary reads
 * belong to lane s2c. Sync ingestion belongs to lanes s2d/s2e.
 */
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { FoodsService } from './foods.service.js';

@RequireIdentityBearer()
@Controller('tracking')
export class FoodsController {
  constructor(private readonly foods: FoodsService) {}

  /** `tracking.foods.search` — GET /tracking/foods?q&limit&cursor */
  @Get('foods')
  search(@Query('q') q: unknown, @Query('limit') limit: unknown, @Query('cursor') cursor: unknown) {
    return this.foods.search(q, limit, cursor);
  }

  /** `tracking.foods.get` — GET /tracking/foods/{foodId} */
  @Get('foods/:foodId')
  foodDetail(@Param('foodId') foodId: string) {
    return this.foods.foodDetail(foodId);
  }

  /** `tracking.barcode.resolve` — GET /tracking/barcode/{barcode} */
  @Get('barcode/:barcode')
  resolveBarcode(@Param('barcode') barcode: string) {
    return this.foods.resolveBarcode(barcode);
  }

  /** `tracking.user-foods.create` — POST /tracking/user-foods (the shared-limiter REST path). */
  @Post('user-foods')
  createUserFood(@Body() body: unknown) {
    return this.foods.createUserFood(body);
  }
}
