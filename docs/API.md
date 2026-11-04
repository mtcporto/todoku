# Todoku API — bootstrap experimental

A API atual apenas **valida** contratos. Mesmo com credencial válida ela responde HTTP 503 `ingestion_not_configured`, porque persistência, idempotência e processamento ainda não estão conectados. **Nenhum evento é aceito, persistido ou enviado.**

## Configuração

- Node.js 24
- `npm install`, `npm run typecheck`, `npm test`, `npm run dev`
- Definir `TODOKU_INGEST_API_KEY` com segredo aleatório de pelo menos 32 caracteres (somente ambiente servidor).
- `GET /api/health` informa estado do serviço.

## Evento

`POST /api/v1/events` com `Authorization: Bearer <secret>` e `Content-Type: application/json`:

```json
{
  "id": "bc3bd75e-fc71-4951-b566-c1505d06d613",
  "type": "user.welcome",
  "occurredAt": "2026-11-04T20:00:00Z",
  "tenantId": "pixelvivo",
  "applicationId": "minhanota",
  "recipient": { "email": "example@example.com" },
  "data": { "firstName": "Exemplo" },
  "idempotencyKey": "welcome-bc3bd75e"
}
```

Limites: 32 KiB por corpo. Respostas: 401 credencial inválida, 415 mídia inválida, 413 excesso de tamanho, 400 JSON inválido, 422 contrato inválido, 503 ingestão desabilitada. A chave atual é única para ambiente de bootstrap e **não proporciona isolamento multi-tenant**; nunca habilite ingestão real sem vincular a credencial ao tenant e à aplicação no servidor.

## Próxima etapa

Turso com credenciais por aplicação, idempotência com índice único por escopo, persistência transacional, fila/outbox e worker; somente depois habilitar respostas de aceite e adaptador Resend. Não transportar chaves Resend do navegador.
