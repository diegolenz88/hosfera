/** Erros de domínio com semântica HTTP explícita. */

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Precondição de estado violada: recurso existe, mas não está no estado exigido. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

/** Entrada inválida detectada na camada de aplicação. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Autenticado, mas sem permissão para a ação. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Credencial ausente ou inválida. */
export class UnauthorizedError extends Error {
  constructor(message = 'credencial ausente ou inválida') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
