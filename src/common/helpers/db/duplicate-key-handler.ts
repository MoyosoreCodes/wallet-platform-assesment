export interface MongoDuplicateKeyError extends Error {
  code: number;
  keyPattern?: Record<string, number>;
  keyValue?: Record<string, unknown>;
}

export function isDuplicateKey(
  error: unknown,
  property?: string[],
): error is MongoDuplicateKeyError {
  if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 11000)
    return false;

  if (!property?.length) return true;

  const keyPattern = (error as MongoDuplicateKeyError).keyPattern ?? {};
  return [property].flat().every((p) => p in keyPattern);
}
