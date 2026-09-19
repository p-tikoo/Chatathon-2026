/**
 * Tiny input-validation helpers. Deliberately dependency-free — a schema
 * library is not worth the install time here, and these give clear 400s.
 */

import { ApiError } from "./http.js";

export function requireFields(body, fields) {
  const missing = fields.filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === "",
  );
  if (missing.length) {
    throw new ApiError(400, `Missing required field(s): ${missing.join(", ")}`, { missing });
  }
}

export function asString(value, field, { maxLength = 500, optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new ApiError(400, `${field} is required`);
  }
  const s = String(value).trim();
  if (s.length > maxLength) {
    throw new ApiError(400, `${field} must be at most ${maxLength} characters`);
  }
  return s;
}

export function asNumber(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new ApiError(400, `${field} is required`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ApiError(400, `${field} must be a number`);
  if (n < min || n > max) {
    throw new ApiError(400, `${field} must be between ${min} and ${max}`);
  }
  return n;
}

export function asInt(value, field, opts = {}) {
  const n = asNumber(value, field, opts);
  return n === null ? null : Math.round(n);
}

export function asBool(value, field, { optional = true, fallback = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return fallback;
    throw new ApiError(400, `${field} is required`);
  }
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase();
  if (["true", "1", "yes"].includes(s)) return true;
  if (["false", "0", "no"].includes(s)) return false;
  throw new ApiError(400, `${field} must be a boolean`);
}

export function asEnum(value, field, allowed, { optional = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return fallback;
    throw new ApiError(400, `${field} is required`);
  }
  const s = String(value);
  if (!allowed.includes(s)) {
    throw new ApiError(400, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return s;
}

export function asDate(value, field, { optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return null;
    throw new ApiError(400, `${field} is required`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(400, `${field} must be a valid ISO 8601 date/time`);
  }
  return d;
}

/** Parses `?from=&to=` into a bounded window, defaulting to [now, now + days]. */
export function parseWindow(searchParams, { defaultDays = 2, maxDays = 14 } = {}) {
  const now = new Date();
  const from = searchParams.get("from") ? new Date(searchParams.get("from")) : now;
  const to = searchParams.get("to")
    ? new Date(searchParams.get("to"))
    : new Date(from.getTime() + defaultDays * 86400000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ApiError(400, "`from` and `to` must be valid ISO 8601 date/times");
  }
  if (to <= from) throw new ApiError(400, "`to` must be after `from`");
  if (to - from > maxDays * 86400000) {
    throw new ApiError(400, `Window may not exceed ${maxDays} days`);
  }
  return { from, to };
}
