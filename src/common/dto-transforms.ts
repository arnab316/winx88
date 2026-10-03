import type { TransformFnParams } from 'class-transformer';

/**
 * Shared `@Transform` helpers for DTOs fed by multipart/form-data.
 *
 * WHY THESE READ `obj[key]` AND NOT `value`
 * -----------------------------------------
 * The global ValidationPipe runs with `transformOptions.enableImplicitConversion`,
 * so class-transformer coerces each field to its reflected TypeScript type
 * BEFORE a custom @Transform sees it. For a `boolean` property that means the
 * multipart string "false" is run through Boolean("false") — which is `true`.
 *
 * The result: every `false` sent from a form silently arrives as `true`, the
 * request still returns 200, and nothing is logged. It made "Active" and
 * "Requires login" toggles look dead in the admin panel.
 *
 * `TransformFnParams.obj` is the ORIGINAL plain object, untouched by implicit
 * conversion, so reading `obj[key]` recovers the string the client actually
 * sent. Always use these helpers for form-backed booleans and numbers.
 */

/** Absent/empty -> undefined ("leave unchanged"); otherwise a real boolean. */
export function toBool({ obj, key }: TransformFnParams): boolean | undefined {
  const raw = obj?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  // Anything not explicitly truthy is false — so "false" and "0" work.
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

/** Absent/empty -> undefined; otherwise a number (NaN is rejected downstream). */
export function toInt({ obj, key }: TransformFnParams): number | undefined {
  const raw = obj?.[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return Number(raw);
}

/**
 * Tri-state for optional enum-ish strings: '' / 'null' mean "clear it" (null),
 * absent means "leave unchanged" (undefined).
 */
export function toNullableEnum({ obj, key }: TransformFnParams): any {
  const raw = obj?.[key];
  if (raw === undefined) return undefined;
  if (raw === '' || raw === null || raw === 'null') return null;
  return raw;
}
