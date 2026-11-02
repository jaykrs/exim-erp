/**
 * Expected, business-rule failures. Route handlers translate these into HTTP responses;
 * anything that is NOT a DomainError is treated as an unexpected 500.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
