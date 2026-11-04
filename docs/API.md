# Todoku API — ingestão durável

Node 24, Next 16, React 19 e TypeScript 6. `POST /api/v1/events` só retorna **202 após commit** de evento, outbox, snapshot de entrega e auditoria no Turso. O worker processa dry-run por padrão. Envios de teste dependem de autorização separada; consulte [DELIVERY.md](DELIVERY.md).

## Configuração e migração

1. `npm install`, `npm run typecheck`, `npm test`, `npm run build`.
2. Copiar `.env.example` para `.env.local`. Configurar `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` somente no servidor, com acesso ao banco específico do Todoku. Não colocar segredos em Git, logs, navegador ou argumentos de comandos.
3. Verificar conta, nome, URL e tabelas do banco via acesso Turso antes de criar recursos ou migrar. Não reutilizar bases de outros aplicativos. O projeto não cria bancos automaticamente.
4. Executar `npm run db:migrate -- libsql://<banco-verificado>.turso.io` usando exatamente a URL configurada. O comando recusa bases existentes sem histórico reconhecido. `migrations/0001_durable_ingestion.sql` é aplicada em transação e registrada em `schema_migrations`, com checksum SHA-256. Reexecutar não altera migrações já aplicadas; checksum diferente falha. Não editar migrações aplicadas; criar nova versão. Não executar migrações em builds ou requests.
5. Executar `npm run db:provision -- <tenant-id> <application-id>` para criar o escopo e uma credencial aleatória de 256 bits. O token é salvo apenas no arquivo local ignorado `.env.credential.<tenant>.<application>.local`, com criação exclusiva, e nunca impresso. No Windows, proteger esse arquivo pelas ACLs da conta; `mode: 0600` não substitui ACLs. Entregar a credencial ao servidor consumidor por um canal seguro. Somente o hash SHA-256 é persistido em `application_credentials`.
6. Configurar as duas variáveis Turso também na Vercel. Nesta fase inicial, Production, Preview e Development usam o mesmo banco `todoku`, conforme decisão do responsável; ver [OPERATIONS.md](OPERATIONS.md). Publicar pelo push e integração GitHub/Vercel; acompanhar o deployment automático, sem publicação manual duplicada.
7. Configurar o transporte do escopo com `npm run db:provider -- dry-run <tenant-id> <application-id>`. Eventos novos exigem configuração ativa e template válido. O modo dry-run não precisa de chave Resend. Para BYOK real, seguir [DELIVERY.md](DELIVERY.md).

Não existe mais `TODOKU_INGEST_API_KEY` global. Cada credencial resolve um único tenant e uma única aplicação no servidor. Para revogar, preencher `revoked_at` na linha do escopo correto; `expires_at` permite expiração. Desativar tenant, aplicação ou o scope da credencial também bloqueia ingestão, inclusive replays. A autenticação é revalidada dentro da transação de escrita.

## Evento

`POST /api/v1/events`, `Authorization: Bearer <credencial-da-aplicação>` e `Content-Type: application/json`:

```json
{
  "id": "bc3bd75e-fc71-4951-b566-c1505d06d613",
  "type": "user.welcome",
  "occurredAt": "2026-11-04T20:00:00Z",
  "tenantId": "pixelvivo",
  "applicationId": "minhanota",
  "trafficType": "transactional",
  "recipient": { "email": "example@example.com" },
  "data": { "firstName": "Exemplo" },
  "idempotencyKey": "welcome-bc3bd75e"
}
```

`tenantId` e `applicationId` são declarações verificadas contra a credencial, nunca a fonte de autoridade. Divergência resulta em 403. `trafficType` tem padrão `transactional`; novos eventos `marketing` retornam 422 `marketing_disabled`. O corpo é limitado a 32 KiB, inclusive durante leitura sem `Content-Length`. Campos extras no contrato são rejeitados. `user.welcome@1` exige `data.firstName` textual; `system.validation@1` exige `synthetic: true` e `purpose`; `system.delivery_test@1` exige `message`. Variáveis desconhecidas ou inválidas são rejeitadas, e todo texto é escapado no HTML.

Resposta 202:

```json
{ "eventId": "<UUID-interno-persistido>", "status": "accepted", "replay": false }
```

`accepted` significa persistido para processamento futuro. Não indica envio nem entrega. Reenvio com a mesma chave e o mesmo payload retorna 202, o mesmo `eventId` e `replay: true`, sem nova outbox ou auditoria. A comparação usa SHA-256 de JSON canônico com chaves ordenadas e `trafficType` padrão preenchido; ordem das listas e valores continuam significativos. Não trocar `id`, data, destinatário ou conteúdo ao repetir uma requisição.

`UNIQUE(tenant_id, application_id, idempotency_key)` protege contra duplicação, inclusive com concorrência. A transação de escrita serializa a verificação e a inserção; contenção ao iniciar a transação tem retry curto e limitado. Conteúdo diferente na mesma chave retorna 409 `idempotency_conflict`. Reutilizar o `id` de origem com outra chave retorna 409 `event_id_conflict`. IDs e chaves podem se repetir em escopos distintos. Após timeout ou 503, o consumidor deve repetir **a mesma chave e payload**: um commit remoto pode ter ocorrido mesmo sem confirmação de rede.

| HTTP | Resultado |
| --- | --- |
| 202 | Persistido ou replay confirmado |
| 400 | `invalid_json` / `invalid_body` |
| 401 | `unauthorized`: credencial ausente, inválida, revogada, expirada ou escopo desativado |
| 403 | `scope_mismatch` / `recipient_not_authorized` |
| 409 | `idempotency_conflict` / `event_id_conflict` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_event`, `marketing_disabled`, `template_not_found`, `invalid_template_variables`, `provider_not_configured` ou `test_send_limit_reached` |
| 503 | `service_unavailable`, sem aceite; repetir com backoff e mesma chave |

Respostas usam `Cache-Control: no-store`; 503 inclui `Retry-After: 5`. Falhas de configuração, persistência, transação e commit não expõem SQL, tokens ou URLs.

## Persistência e isolamento

Migração cria `tenants`, `applications`, `application_credentials`, `events`, `outbox_messages`, `delivery_attempts`, `provider_webhook_events` e `audit_log`. Tabelas operacionais carregam `tenant_id` e `application_id`, com chaves e FKs compostas para impedir referências cruzadas. Índices de consulta incluem o escopo. Estados e contadores têm CHECKs; auditoria é protegida contra UPDATE/DELETE por triggers. A conta administrativa do banco continua capaz de alterar o schema; isso não equivale a armazenamento WORM.

`payload_json` contém dados pessoais do evento e destinatário: restringir o acesso ao banco e definir retenção antes de uso real. A auditoria registra apenas ação, escopo, credencial e referência ao evento. Credenciais de ingestão são hashes de tokens aleatórios. Segredos BYOK ficam em `provider_configurations` com AES-256-GCM e contexto autenticado por tenant, aplicação, configuração e finalidade; não são armazenados na tabela de credenciais de ingestão.

## Outbox, processamento e status

Uma mensagem por evento/canal começa em `pending`, sem nenhuma tentativa de entrega. `message_deliveries` guarda configuração, versão de template, conteúdo e chave de envio congelados para retries. Marketing fica separado e desabilitado. O worker usa claim transacional, lease de 120 segundos, token de posse e até cinco tentativas, sem manter uma transação aberta durante a chamada ao Resend.

Estados da fila: `pending`, `processing`, `retry_wait`, `sent`, `dead`, `cancelled`, `manual_review`. Estado de entrega separado: `queued`, `dry_run`, `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed`, `manual_review`. Uma simulação concluída marca a entrega `dry_run` e a fila `cancelled`, impedindo que uma troca posterior de modo envie a mensagem simulada. `sent` significa aceite do provedor; `delivered` depende de webhook assinado e indica entrega ao servidor destinatário, não leitura ou caixa de entrada.

`GET /api/v1/events/<eventId>` usa a mesma credencial de aplicação e retorna somente o próprio escopo, com estado da fila/entrega, tentativas, código de erro e ID do provedor. Não retorna destinatário, corpo ou segredos. IDs de outro escopo retornam 404.

`GET /api/internal/worker` é autenticado por `CRON_SECRET` e executa apenas dry-run, também agendado a cada cinco minutos na Vercel. `POST` no mesmo endpoint é uma operação de teste controlado, bloqueada por padrão; ver [DELIVERY.md](DELIVERY.md). `POST /api/webhooks/resend/<configurationId>` verifica assinatura Svix sobre os bytes originais, timestamp e contexto da configuração antes de persistir e processar o evento. Não aceita IDs de tenant/aplicação declarados no webhook como autoridade.

## Saúde e validação

`GET /api/health` consulta a migração `0002_delivery` e a presença das doze tabelas operacionais. Retorna 200 com `status: ready`, `ingestion: durable`, `delivery: dry_run`, `marketing: disabled`, ou 503 com estado indisponível. `delivery` descreve o processamento padrão do cron; a operação POST de teste tem autorização separada. Nunca retorna credenciais, URL, nome de tenant ou payloads. Não é um monitor de entrega.

`npm test` usa libSQL/SQLite real em bancos temporários e clientes independentes para isolamento, autenticação, expiração, replay, conflito concorrente, rollback de outbox/auditoria, falha de commit, FKs e integridade, limites HTTP, migrações e health. Essas verificações locais não comprovam configuração ou acesso ao Turso remoto. A validação remota deve inspecionar o banco escolhido, aplicar migração e testar aceite/replay/conflito no ambiente publicado, sem chamar provedores de e-mail.

`npm run smoke:ingestion -- http://127.0.0.1:3037` usa o banco de `.env.local` e testa uma instância HTTP iniciada com as mesmas variáveis. Para um ambiente publicado, carregar explicitamente o arquivo privado correspondente, por exemplo `node --env-file=.env.production.local --experimental-strip-types scripts/smoke-ingestion.ts https://todoku.com.br`. O comando exige health pronto e envio desativado, cria escopos sintéticos com credenciais temporárias, verifica 202/replay/409/403/401 e oito replays simultâneos, e confirma as contagens diretamente no Turso. Ao terminar, revoga as credenciais, desativa os tenants e cancela as mensagens de teste, preservando eventos e auditoria. Não executar contra ambiente com worker de envio habilitado. Para preview protegido, pode usar `VERCEL_OIDC_TOKEN` local, enviado apenas ao hostname Vercel escolhido.

`npm run smoke:delivery -- <origem>` testa o fluxo completo de simulação no Turso real: ingestão, worker autenticado, estado consultável, tentativa e auditoria. Não constrói o adaptador Resend, revoga as credenciais temporárias e desativa o tenant ao final. Consulte [OPERATIONS.md](OPERATIONS.md) para o banco selecionado.
