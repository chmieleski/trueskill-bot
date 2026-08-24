export class DocsServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocsServiceError';
  }
}
