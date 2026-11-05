# Mail — APIs administrativas (MVP 3, entrega 2)

> Publicada pela PR #24 em `37e20d4`. A entrega 3 acrescenta [convites e sessões](MAIL-USERS-INVITATIONS.md), preservando estes endpoints, escopos e guards.

Base: main `85c17e7`, depois da publicação da PR #23. Esta entrega reutiliza a migração `0007` e os guards de conteúdo, sem nova migração ou backfill. A PR deve permanecer aberta para revisão; não autoriza mutações reais de permissões durante os testes remotos.

## Autenticação e escopos

Todas as rotas exigem a sessão opaca existente, por senha ou Google OIDC. IDs internos determinam privilégios; endereço Google, username e identidade de envio não concedem administração. As listagens usam snapshot de leitura; as mutações revalidam **sessão, usuário, tenant, membership e papel dentro da transação de escrita**, depois de ler o corpo. Mutações exigem Origin permitido e rejeitam `Sec-Fetch-Site: cross-site`. Não há CORS permissivo nem autenticação por ID fornecido pelo cliente.

| Papel ativo | Metadados visíveis | Delegação administrativa | Memberships |
| --- | --- | --- | --- |
| Organização | Organização e seus domínios, caixas, membros, papéis e grants | Organização, domínio ou caixa do mesmo tenant | Pode associar usuário interno existente, suspender e reativar |
| Domínio | Domínio e suas caixas; somente membros, papéis e grants relacionados a esse escopo | Mesmo domínio ou uma caixa dele; nunca organização/outro domínio | Pode listar membros relacionados; não altera membership organizacional |
| Caixa | Caixa e metadados mínimos de seu domínio/organização; membros, papéis e grants dessa caixa | Somente a mesma caixa | Pode listar membros relacionados; não altera membership organizacional |

As listagens incluem estados inativos/revogados para futura administração, mas o ator precisa de membership e papel ativos. Ver metadados do domínio pai de uma caixa não permite administrar esse domínio ou enumerar suas outras caixas. Um administrador não precisa de grant de leitura para administrar metadados ou revogar acesso.

Nenhuma resposta administrativa seleciona corpos, assuntos, previews, anexos, chaves de storage, sessões/tokens, bindings Google, hashes de senha ou configurações/credenciais de providers. Projeções SQL explícitas retornam somente os campos de metadados documentados.

## Endpoints de leitura

Prefixo: `/api/mail/admin`.

| Método e caminho | Campos de cada item |
| --- | --- |
| `GET /organizations` | `id`, `status` dos tenants administráveis |
| `GET /organizations/:tenant/domains` | `id`, `name`, `status` |
| `GET /organizations/:tenant/mailboxes` | `id`, `domain_id`, `address`, `label`, `status` |
| `GET /organizations/:tenant/memberships` | `user_id`, `username`, `status` da membership, `account_status` global somente de leitura |
| `GET /organizations/:tenant/roles` | `id`, `user_id`, `scope`, `domain_id`, `identity_id`, `status` |
| `GET /organizations/:tenant/grants` | `identity_id`, `user_id`, `can_read`, `can_send`, `can_manage` |

Resposta: `{ "items": [...], "nextCursor": null }`. Paginação por chave estável, `limit` padrão 50, máximo 100. Passar `cursor` opaco da resposta para continuar. Cursor pertence à coleção, tenant e filtros; não concede privilégios e os escopos são reavaliados em cada página. Alterações concorrentes podem mudar o conjunto entre páginas; não há snapshot durável de navegação.

`mailboxes` aceita filtro `domainId`. `grants` aceita `domainId` e/ou `identityId`. Demais filtros, parâmetros duplicados ou cursores incompatíveis são rejeitados. Filtros fora do escopo retornam lista vazia, sem fallback. Sem papel ativo, `/organizations` retorna lista vazia; uma coleção de tenant sem autorização retorna 403.

IDs são opacos, com 1–100 caracteres alfanuméricos, `_` ou `-`; o primeiro caractere deve ser alfanumérico. Os UUIDs existentes são preservados. Não há busca global de usuários por e-mail ou enumeração de outras organizações.

## Mutações

JSON estrito, corpo máximo de 4 KiB, sem query string. Campos desconhecidos, tipos incorretos e combinações de escopo inválidas são rejeitados. Retorno: `{ "changed": true }`; repetição do mesmo estado retorna `false`, sem duplicar auditoria. PUT representa o estado completo dos campos editáveis; não é PATCH. Requisições concorrentes autorizadas são serializadas no banco; não há promessa de detecção de edição obsoleta no cliente.

### Membership de usuário existente

`PUT /organizations/:tenant/memberships/:userId`

```json
{ "status": "active" }
```

Estados: `active` ou `suspended`. Somente administrador da organização. Ativação de membership nova exige usuário interno existente e ativo; não cria conta, convite, papel, grant ou binding. Suspensão preserva papéis, grants e sessões globais, bloqueando acesso somente no tenant. Não há exclusão física ou alteração do status global do usuário.

Reativação pode restaurar grants antigos. Por isso, cada permissão de conteúdo restaurada também precisa caber no limite de delegação do ator. Usuário globalmente desativado não pode ser reativado por esta API.

### Papel administrativo

`PUT /organizations/:tenant/roles`

```json
{ "userId": "USER_ID", "scope": "domain", "domainId": "DOMAIN_ID", "status": "active" }
```

`scope=organization` não aceita IDs de recurso; `domain` exige somente `domainId`; `mailbox` exige somente `identityId`. `status`: `active` ou `revoked`. A chave lógica é usuário + escopo + recurso. Reativar/revogar conserva o ID da role; não há retargeting ou exclusão física. Ativação exige membership e conta do alvo ativas. Atribuir um papel **não cria nem modifica grants de conteúdo**.

Delegar papel igual é permitido dentro do mesmo escopo. Administrador de domínio não concede/revoga papel organizacional; administrador de caixa não concede/revoga papel de domínio. Não há operador global ou papel superior implícito.

### Grant de conteúdo

`PUT /organizations/:tenant/mailboxes/:identityId/grants/:userId`

```json
{ "canRead": false, "canSend": true, "canManage": false }
```

Os três booleanos são obrigatórios e independentes. `canManage=true` não liga leitura automaticamente; o guard existente só permite gestão geral quando há **leitura e gerenciamento**. Envio sem leitura continua limitado a rascunhos/envios próprios conforme a PR #23.

Exige papel administrativo que cubra a caixa e membership do alvo. **Papel administrativo não é uma reserva de permissões de conteúdo**: cada novo bit de leitura/envio precisa existir no grant do ator naquela caixa; delegar gerenciamento exige leitura+gerenciamento do ator. Também é verificada a transição que tornaria um `can_manage` latente efetivo ao adicionar leitura. Isso impede autoelevação por combinações de bits.

Permissões já existentes do alvo podem ser conservadas enquanto outras são reduzidas. Revogar não exige possuir a leitura revogada. Membros suspensos só podem sofrer reduções; novas permissões exigem membership e conta ativas. Um administrador sem conteúdo precisa de outro delegante autorizado ou de recuperação explícita por operador para receber novos grants; não há bypass administrativo.

`DELETE /organizations/:tenant/mailboxes/:identityId/grants/:userId` revoga o grant inteiro. Corpo ausente ou `{}`. Preserva mensagens, rascunhos, anexos e papéis; os guards deixam de disponibilizar o conteúdo nas sessões existentes. Repetir a exclusão é idempotente.

## Último administrador e auditoria

Revogar papel organizacional ou suspender membership não pode deixar a organização sem administrador efetivo. A contagem considera papel, membership e conta ativos; contas desativadas e papéis revogados não contam. Verificação, alteração e auditoria compartilham a transação de escrita. Duas requisições concorrentes não podem remover os dois últimos administradores. Uma falha de persistência da auditoria desfaz a mutação.

`mail_administration_audit` conserva UUID de ator e alvo, ação e estado anterior/posterior permitido. Ações: `membership_updated`, `administrative_role_updated`, `content_grant_updated`, `content_grant_revoked`. Detalhes incluem somente escopo/recurso/booleans/status; não armazenam o corpo arbitrário da requisição ou dados de mensagens/credenciais. No-op não cria evento duplicado.

## Capacidades na sessão

`GET /api/mail/session` preserva `user` e acrescenta:

```json
{
  "administration": {
    "canAdminister": true,
    "scopes": [{ "tenantId": "TENANT_ID", "scope": "organization", "domainId": null, "identityId": null }]
  }
}
```

Sem papel ativo: `canAdminister=false`, `scopes=[]`. São capacidades administrativas de navegação, não grants de conteúdo nem autorização durável. O servidor revalida cada chamada, independentemente da UI ou desse snapshot.

## Erros e testes

- 400: `invalid_request`, `invalid_filter`, `invalid_cursor`; 413: `payload_too_large`.
- 401: sessão ausente/revogada, expirada ou conta desativada.
- 403: `invalid_origin`, `administration_not_permitted`, `content_delegation_exceeds_permissions`.
- 404: `not_found`/`member_not_found` para recurso/alvo inválido no escopo.
- 409: `member_inactive`, `last_organization_administrator`.
- 405: operação/método não implementado. 503: indisponibilidade/falha de persistência, sem detalhes de SQL ou segredos. Em contenção de banco, uma requisição pode falhar fechada; reler estado e repetir o PUT/DELETE idempotente.

Testes usam bancos locais isolados com 0007 e transports/storage sintéticos: delegação por escopo, teto de conteúdo, autoelevação negada, restauração de membership, último administrador/concorrência, rollback de auditoria, revogação durante leitura do corpo, sessões existentes, caixas compartilhadas, paginação, ausência de segredos e preservação dos dados anteriores. Regressões de conteúdo, OIDC, envio e recebimento continuam na suíte.

Não há painel completo, convites, cadastro público, mudança de quota, criação/ativação de domínio/caixa, provisionamento Resend, DNS, migração ou envio externo nesta entrega. Catálogos e mutações de acesso não alteram Sending, Receiving, Notifications ou o plano contratado. Recuperação continua exigindo código compatível com `can_read` e autoria; nunca voltar ao servidor anterior à PR #23.
