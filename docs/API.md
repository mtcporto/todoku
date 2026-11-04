# Todoku API — ingestão durável

Node 24, Next 16, React 19 e TypeScript 6. `POST /api/v1/events` só retorna **202 após commit** de evento, outbox e auditoria no Turso. Não há worker, chamada Resend, webhook público nem envio externo nesta entrega.

## Configuração e migração

1. `npm install`, `npm run typecheck`, `npm test`, `npm run build`.
2. Copiar `.env.example` para `.env.local`. Configurar `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` somente no servidor, com acesso ao banco específico do Todoku. Não colocar segredos em Git, logs, navegador ou argumentos de comandos.
3. Verificar conta, nome, URL e tabelas do banco via acesso Turso antes de criar recursos ou migrar. Não reutilizar bases de outros aplicativos. O projeto não cria bancos automaticamente.
4. Executar `npm run db:migrate -- libsql://<banco-verificado>.turso.io` usando exatamente a URL configurada. O comando recusa bases existentes sem histórico reconhecido. `migrations/0001_durable_ingestion.sql` é aplicada em transação e registrada em `schema_migrations`, com checksum SHA-256. Reexecutar não altera migrações já aplicadas; checksum diferente falha. Não editar migrações aplicadas; criar nova versão. Não executar migrações em builds ou requests.
5. Executar `npm run db:provision -- <tenant-id> <application-id>` para criar o escopo e uma credencial aleatória de 256 bits. O token é salvo apenas no arquivo local ignorado `.env.credential.<tenant>.<application>.local`, com criação exclusiva, e nunca impresso. No Windows, proteger esse arquivo pelas ACLs da conta; `mode: 0600` não substitui ACLs. Entregar a credencial ao servidor consumidor por um canal seguro. Somente o hash SHA-256 é persistido em `application_credentials`.
6. Configurar as duas variáveis Turso também na Vercel. Nesta fase inicial, Production, Preview e Development usam o mesmo banco `todoku`, conforme decisão do responsável; ver [OPERATIONS.md](OPERATIONS.md). Publicar pelo push e integração GitHub/Vercel; acompanhar o deployment automático, sem publicação manual duplicada.

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

`tenantId` e `applicationId` são declarações verificadas contra a credencial, nunca a fonte de autoridade. Divergência resulta em 403. `trafficType` aceita `transactional` (padrão) ou `marketing`. O corpo é limitado a 32 KiB, inclusive durante leitura sem `Content-Length`. Campos extras no contrato são rejeitados.

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
| 403 | `scope_mismatch` |
| 409 | `idempotency_conflict` / `event_id_conflict` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_event`, apenas caminhos/códigos de validação |
| 503 | `service_unavailable`, sem aceite; repetir com backoff e mesma chave |

Respostas usam `Cache-Control: no-store`; 503 inclui `Retry-After: 5`. Falhas de configuração, persistência, transação e commit não expõem SQL, tokens ou URLs.

## Persistência e isolamento

Migração cria `tenants`, `applications`, `application_credentials`, `events`, `outbox_messages`, `delivery_attempts`, `provider_webhook_events` e `audit_log`. Tabelas operacionais carregam `tenant_id` e `application_id`, com chaves e FKs compostas para impedir referências cruzadas. Índices de consulta incluem o escopo. Estados e contadores têm CHECKs; auditoria é protegida contra UPDATE/DELETE por triggers. A conta administrativa do banco continua capaz de alterar o schema; isso não equivale a armazenamento WORM.

`payload_json` contém dados pessoais do evento e destinatário: restringir o acesso ao banco e definir retenção antes de uso real. A auditoria registra apenas ação, escopo, credencial e referência ao evento. Credenciais de ingestão são hashes de tokens aleatórios; BYOK Resend futuro exigirá armazenamento criptografado separado por tenant e não deve usar esta tabela para tokens recuperáveis.

## Outbox e retry futuro

Uma mensagem por evento/canal começa em `pending`, sem nenhuma tentativa de entrega. `traffic_type` é preservado por FK e índice; o futuro worker deverá consumir filas `transactional` e `marketing` separadamente, sempre com escopo explícito, prioridade e limites próprios. Marketing ainda precisa de consentimento, opt-out, preferências e políticas antes de habilitar envio.

Estados preparados: `pending`, `processing`, `retry_wait`, `sent`, `dead`, `cancelled`, `manual_review`. Campos `available_at`, `locked_until`, `attempt_count` e `max_attempts` permitem claims atômicos, leases e limites. Padrão: até cinco tentativas. A política em `src/lib/queue-policy.ts` define backoff exponencial desde 30 segundos com jitter, limitado a uma hora, apenas para falha transitória com não envio confirmado. Erro permanente esgota o trabalho; resultado ambíguo exige `manual_review`. Lease expirado não prova ausência de envio. O futuro worker deve usar a mesma chave de idempotência no provedor e reconciliar resultados ambíguos antes de tentar novamente. Não existe cron ou worker ativo nesta entrega.

Webhooks têm identidade única por escopo/provedor/evento, mas seu endpoint e validação de assinatura ainda não foram implementados. Não inserir eventos externos como autenticados sem verificar assinatura e resolver o escopo no servidor.

## Saúde e validação

`GET /api/health` consulta o histórico real de migração e a presença das oito tabelas operacionais. Retorna 200 com `status: ready`, `ingestion: durable`, `delivery: disabled` apenas com schema disponível, ou 503 com estado indisponível. Nunca retorna credenciais, URL, nome de tenant ou payloads. Não é um monitor de entrega.

`npm test` usa libSQL/SQLite real em bancos temporários e clientes independentes para isolamento, autenticação, expiração, replay, conflito concorrente, rollback de outbox/auditoria, falha de commit, FKs e integridade, limites HTTP, migrações e health. Essas verificações locais não comprovam configuração ou acesso ao Turso remoto. A validação remota deve inspecionar o banco escolhido, aplicar migração e testar aceite/replay/conflito no ambiente publicado, sem chamar provedores de e-mail.

`npm run smoke:ingestion -- http://127.0.0.1:3037` usa o banco de `.env.local` e testa uma instância HTTP iniciada com as mesmas variáveis. Para um ambiente publicado, carregar explicitamente o arquivo privado correspondente, por exemplo `node --env-file=.env.production.local --experimental-strip-types scripts/smoke-ingestion.ts https://todoku.com.br`. O comando exige health pronto e envio desativado, cria escopos sintéticos com credenciais temporárias, verifica 202/replay/409/403/401 e oito replays simultâneos, e confirma as contagens diretamente no Turso. Ao terminar, revoga as credenciais, desativa os tenants e cancela as mensagens de teste, preservando eventos e auditoria. Não executar contra ambiente com worker de envio habilitado. Para preview protegido, pode usar `VERCEL_OIDC_TOKEN` local, enviado apenas ao hostname Vercel escolhido.

Consulte [OPERATIONS.md](OPERATIONS.md) para os bancos selecionados e a separação de ambientes.
