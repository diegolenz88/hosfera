import { openDatabase } from './db/database.ts';
import { createApp } from './http/app.ts';
import { config } from './config.ts';

const db = openDatabase(config.databasePath);
const app = createApp({ db, startWorker: true });

const shutdown = async (signal: string): Promise<void> => {
  app.log.warn(`recebido ${signal}, encerrando`);
  await app.close();
  db.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`hosfera api em http://${config.host}:${config.port} · env=${config.env}`);
  console.log(`banco: ${config.databasePath}`);
  console.log('autenticação: header x-api-key');
} catch (error) {
  console.error('falha ao iniciar:', error);
  process.exit(1);
}
