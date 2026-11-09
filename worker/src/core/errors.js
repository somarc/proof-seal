/** An error that maps to an HTTP status and a stable `code` for `{ error: { code, message } }`. */
export default class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
