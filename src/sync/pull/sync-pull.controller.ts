/**
 * Kal — the sync delta pull HTTP surface (wave-03 contract note §2,
 * `sync.changes.pull`; fixtures `w3`).
 *
 * Exactly the frozen endpoint: `GET /sync/changes` (auth: bearer) with the
 * opaque user-bound `cursor` and the clamped `limit`. 200 serves the delta
 * envelope `{changes, nextCursor}`; every cursor failure class and a
 * malformed `limit` are the ONE generic `400 VALIDATION_FAILED` problem-
 * details body (conventions §2/§4 — byte-identical per situation class);
 * missing/invalid credentials are the generic `401 UNAUTHENTICATED` with
 * the bearer challenge (conventions §1, via the identity bearer guard).
 * The guard resolves the JWT through the same USER_CONTEXT_RESOLVER seam
 * every authenticated route uses and stores the validated context (I2);
 * handlers fail closed if it is somehow absent (never a default tenant).
 */
import { Controller, Get, Query } from '@nestjs/common';
import { RequireIdentityBearer } from '../../identity/identity-bearer.guard.js';
import { KalProblemException } from '../../problems/kal-problem.exception.js';
import { RequestContextService } from '../../request-context/request-context.service.js';
import { SyncPullPage, SyncPullService } from './sync-pull.service.js';

@Controller('sync')
export class SyncPullController {
  constructor(
    private readonly pullService: SyncPullService,
    private readonly requestContext: RequestContextService,
  ) {}

  @Get('changes')
  @RequireIdentityBearer()
  async pull(@Query('cursor') cursor: unknown, @Query('limit') limit: unknown): Promise<SyncPullPage> {
    const userId = this.requireUserId();
    return this.pullService.pull(
      userId,
      typeof cursor === 'string' ? cursor : null,
      typeof limit === 'string' ? limit : null,
    );
  }

  /** Guards set the context; absence here is a fail-closed refusal (I2). */
  private requireUserId(): string {
    const context = this.requestContext.getUserContext();
    if (context === undefined || context.kind !== 'consumer') {
      throw new KalProblemException('UNAUTHENTICATED');
    }
    return context.userId;
  }
}
