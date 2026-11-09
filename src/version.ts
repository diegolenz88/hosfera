import { readFileSync } from 'node:fs';

/**
 * Versão lida do `package.json` em runtime.
 *
 * Fonte única: um hardcode em `/health` diverge do pacote publicado na primeira
 * vez que alguém esquece de atualizar os dois lugares.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };

export const VERSION = pkg.version ?? '0.0.0';
