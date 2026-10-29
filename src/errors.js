/**
 * Error raised for conditions the API deliberately reports to callers
 * (bad input, unknown resources). Anything else reaching the HTTP layer is
 * either an upstream portal failure or an unexpected bug.
 */
export class ApiError extends Error {
  /**
   * @param {number} status - HTTP status code
   * @param {string} code - Stable machine-readable error code
   * @param {string} message - Human-readable explanation
   * @param {object} [details] - Extra structured context (e.g. allowed values)
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, 'bad_request', message, details);
export const notFound = (message) => new ApiError(404, 'not_found', message);
