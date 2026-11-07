/**
 * Transporte das mensagens OTA.
 *
 * Separado do adaptador de propósito: o protocolo (XML) é testável sem rede, e a
 * homologação substitui apenas esta peça. Em produção é `FetchTransport`; nos
 * testes, um transporte que grava requisições e devolve respostas fixas.
 */

export interface TransportRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
  /** Nome lógico da mensagem, para log e métrica. */
  operation: string;
}

export interface TransportResponse {
  status: number;
  body: string;
}

export interface Transport {
  post(request: TransportRequest): Promise<TransportResponse>;
}

export class TransportError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'TransportError';
    this.retryable = retryable;
  }
}

/** HTTP real com Basic auth e timeout. 5xx/429/rede são retentáveis. */
export class FetchTransport implements Transport {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 20_000) {
    this.timeoutMs = timeoutMs;
  }

  async post(request: TransportRequest): Promise<TransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/xml; charset=utf-8', ...request.headers },
        body: request.body,
        signal: controller.signal,
      });
      const body = await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new TransportError(`HTTP ${response.status} no Booking`, true);
      }
      if (response.status === 401 || response.status === 403) {
        throw new TransportError(`credencial recusada pelo Booking (HTTP ${response.status})`, false);
      }
      return { status: response.status, body };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TransportError(`timeout de ${this.timeoutMs}ms no Booking`, true);
      }
      throw new TransportError(error instanceof Error ? error.message : String(error), true);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Transmissão em memória: usado por testes e pelo modo sandbox sem rede. */
export class MemoryTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  private readonly responder: (request: TransportRequest) => TransportResponse;

  constructor(responder: (request: TransportRequest) => TransportResponse) {
    this.responder = responder;
  }

  async post(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    return this.responder(request);
  }
}
