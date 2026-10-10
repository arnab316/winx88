import {
  CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor,
} from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';
import { AdminActivityService } from './admin-activity.service';
import { findRule } from './admin-activity.rules';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records every admin write request in admin_activity_logs (the Track log).
 *
 * Global, so a new admin endpoint is tracked the day it ships. Runs after the
 * guards, which is what puts the admin identity on the request:
 *   AdminGuard        → req.admin.id
 *   SuperAdminGuard   → req.user (type ADMIN / non-USER role)
 * Player requests and unauthenticated callbacks carry neither and are skipped.
 *
 * Recording happens after the response is decided and is never awaited by the
 * request — the admin's action is never slowed or failed by the log.
 */
@Injectable()
export class AdminActivityInterceptor implements NestInterceptor {
  constructor(private readonly activity: AdminActivityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const method = String(req.method ?? '').toUpperCase();
    if (!WRITE_METHODS.has(method)) return next.handle();

    const adminId = this.adminIdOf(req);
    if (!adminId) return next.handle();

    const path: string = req.route?.path ?? req.path ?? req.url;
    const rule = findRule(method, path);
    const ctx = {
      params: { ...(req.params ?? {}) },
      body: req.body && typeof req.body === 'object' ? req.body : {},
      query: { ...(req.query ?? {}) },
    };
    const base = {
      adminId, method, path, ctx, rule,
      ip: req.ip, userAgent: req.headers?.['user-agent'],
    };

    // Profile edits keep a before-snapshot so the log can say what changed.
    const userId = Number(req.params?.userId);
    const before$ =
      rule?.action === 'USER_EDIT' && userId
        ? from(this.activity.profileSnapshot(userId))
        : from(Promise.resolve(null));

    return before$.pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap(() => {
            const res = context.switchToHttp().getResponse();
            void this.activity.record({ ...base, before, success: true, statusCode: res?.statusCode });
          }),
          catchError((err) => {
            void this.activity.record({
              ...base,
              before,
              success: false,
              statusCode: err instanceof HttpException ? err.getStatus() : 500,
              error: err?.message,
            });
            return throwError(() => err);
          }),
        ),
      ),
    );
  }

  private adminIdOf(req: any): number | null {
    const id = req.admin?.id
      ?? (req.user && (req.user.type === 'ADMIN' || (req.user.role && req.user.role !== 'USER'))
        ? req.user.sub
        : null);
    const n = Number(id);
    return Number.isInteger(n) && n > 0 ? n : null;
  }
}
