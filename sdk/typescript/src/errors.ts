/**
 * TencentDB Agent Memory SDK error types.
 */

export class TDAMError extends Error {
  readonly code: number;
  readonly requestId: string;

  constructor(code: number, message: string, requestId = "") {
    super(`[${code}] ${message} (request_id=${requestId})`);
    this.name = "TDAMError";
    this.code = code;
    this.requestId = requestId;
  }
}
