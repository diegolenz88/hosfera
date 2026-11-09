#!/usr/bin/env node
/**
 * Verifica se a máquina atende aos pré-requisitos antes de rodar.
 *
 * `node src/main.ts` exige Node >= 24 (type stripping nativo + node:sqlite).
 * Falhar aqui com mensagem clara é melhor do que um erro de sintaxe TypeScript
 * no meio do `npm start`.
 */
import { DatabaseSync } from 'node:sqlite';

const MIN_MAJOR = 24;
const [major] = process.versions.node.split('.').map(Number);

const ok = (label) => console.log(`  ok    ${label}`);
const fail = (label) => console.log(`  FALHA ${label}`);

console.log('\nhosfera · verificação de ambiente\n');
console.log(`  node      ${process.version}`);
console.log(`  plataforma ${process.platform} ${process.arch}`);
console.log(`  cwd        ${process.cwd()}\n`);

let problems = 0;

if (major >= MIN_MAJOR) ok(`Node ${MIN_MAJOR}+ (type stripping nativo)`);
else {
  fail(`Node ${process.version} é antigo; instale Node ${MIN_MAJOR}+ (nvm install ${MIN_MAJOR})`);
  problems++;
}

try {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  db.prepare('INSERT INTO t (x) VALUES (?)').run(1);
  const row = db.prepare('SELECT x FROM t').get();
  db.close();
  if (row?.x === 1) ok('node:sqlite disponível');
  else {
    fail('node:sqlite respondeu de forma inesperada');
    problems++;
  }
} catch (error) {
  fail(`node:sqlite indisponível: ${error instanceof Error ? error.message : error}`);
  problems++;
}

try {
  await import('fastify');
  ok('dependências instaladas (fastify)');
} catch {
  fail('dependências ausentes: rode `npm install`');
  problems++;
}

console.log('');
if (problems === 0) {
  console.log('ambiente pronto. próximos passos:');
  console.log('  npm run seed   # cria cenário demo e imprime o token');
  console.log('  npm start      # abre em http://127.0.0.1:3000');
  process.exit(0);
}
console.log(`${problems} problema(s) encontrado(s). Veja GUIA-LOCAL.md.`);
process.exit(1);
