export class ReleaseServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseServiceError';
  }
}
