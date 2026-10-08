export class ApplicationError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;

  constructor(status: number, code: string, title: string, detail: string) {
    super(detail);
    this.name = 'ApplicationError';
    this.status = status;
    this.code = code;
    this.title = title;
  }
}

export function badRequest(code: string, detail: string): ApplicationError {
  return new ApplicationError(400, code, 'Invalid request', detail);
}

export function notFound(code: string, detail: string): ApplicationError {
  return new ApplicationError(404, code, 'Resource not found', detail);
}

export function conflict(code: string, detail: string): ApplicationError {
  return new ApplicationError(409, code, 'Booking conflict', detail);
}

export function unprocessable(code: string, detail: string): ApplicationError {
  return new ApplicationError(422, code, 'Business rule violation', detail);
}
