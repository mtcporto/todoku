# Todoku Hub — MVP funcional (06/11/2026)

## Diagnóstico e sequência

Ingestão durável, credenciais por aplicação, isolamento, idempotência, snapshot,
worker/cron, retries, Resend, BYOK e webhooks já existiam. Um envio controlado foi
validado na issue #6; isso não habilitou Notifications em geral. A consulta
somente leitura do Turso em 06/11 encontrou migrações 0001–0008 e eventos de
validação, sem uma aplicação MinhaNota operacional configurada no Hub.

Lacunas: catálogo configurável por aplicação, associação evento/template,
ativação individual, operação visual do Hub e consumidor real. Sequência de PRs:
1. Configuração/API e migração aditiva 0009 (este documento).
2. Interface mínima `/hub`, separada de `/mail/admin`.
3. Boas-vindas do MinhaNota consumindo a API; validação integrada em dry-run.

Essas entregas estão **em revisão**, não publicadas. A documentação canônica da
PR #30 já foi integrada à `main` por squash em `992590fa`. A branch da PR #31
foi sincronizada com essa base, preservando as adições do Hub e sem merge das
PRs de implementação.

## Configuração e compatibilidade

`0009_hub_operations` adiciona apenas tabelas/índices/triggers do Hub. Nenhuma
tabela, migração ou permissão do Mail é modificada. `hub_administrators` associa
explicitamente UUID interno e tenant. Nem login Google nem papéis do Mail
concedem administração do Hub. Reutiliza-se a sessão opaca existente, não um SSO.

Depois de revisão: fazer backup/restore point do banco escolhido, validar
`PRAGMA integrity_check` e `foreign_key_check`, aplicar a migração explicitamente,
comparar contagens e integridade e só então publicar por GitHub/Vercel. Builds,
requests e previews nunca migram bancos. A ausência de 0009 preserva ingestão
legada; a API administrativa retorna `503 hub_setup_required`.

O bootstrap exige autorização explícita, UUIDs existentes e
`TODOKU_HUB_ADMIN_BOOTSTRAP_CONFIRMED=true`; executar com o ambiente privado
correto `node --experimental-strip-types scripts/bootstrap-hub-administrator.ts
<tenant> <user-uuid> <actor-uuid>`. A operação é transacional e auditada. Não foi
executada no banco remoto nesta entrega.

Aplicações legadas mantêm os três templates originais até adotar explicitamente
o catálogo. A adoção é irreversível pela interface e começa com as quatro
comunicações comuns **desabilitadas**, sem alterar o provedor. Confirmar essa
mudança para não interromper um evento legado em uso. Não há fallback para um
template global quando a aplicação já tem catálogo próprio.

Uma nova aplicação reutiliza somente os dados públicos de um remetente já
configurado no mesmo tenant; ganha configuração **dry-run**, sem copiar BYOK,
segredo de webhook ou verificação de domínio. A credencial de ingestão aleatória
é exibida uma vez e apenas seu hash é persistido. Não modifica configurações
existentes. Para uma aplicação já existente, usa-se a credencial já provisionada.
Configuração real de envio continua com o procedimento autorizado de [Delivery](DELIVERY.md).

## Templates e políticas

Comuns: boas-vindas, verificação de e-mail, recuperação de senha e alerta de
segurança. Não criam tokens de autenticação: a aplicação consumidora gera seus
links e decide o evento. Apenas textos e URLs HTTPS sem credenciais são aceitos.
Não há HTML editável, scripts, helpers ou includes remotos. Variáveis são
obrigatórias, limitadas e estritas; HTML é escapado e cabeçalhos não aceitam
quebras de linha. URLs são dados fornecidos por aplicações autenticadas, não
validadas como prova de propriedade de domínio.

Templates específicos são versões imutáveis. O binding escolhe a versão e o
evento; publicar uma versão não troca bindings automaticamente. Snapshot,
destinatário e idempotency key permanecem congelados na ingestão. Desabilitar
uma comunicação bloqueia novos eventos e é revalidado pelo worker para trabalhos
pendentes (entram em `manual_review`); não desfaz chamadas já em trânsito.

Replays idênticos continuam retornando o aceite original, mesmo após desativação,
sem criar trabalho. Eventos novos desabilitados retornam `422 communication_disabled`.
Preview de template não cria evento ou tentativa. Marketing, quotas do Mail,
Sending/Receiving, DNS, Resend e flags existentes permanecem intactos.

## API administrativa

Todas as respostas são `no-store`. Sessão e autorização são revalidadas no
servidor; mutações validam origem, corpo limitado, esquema estrito e autorização
na própria transação que grava a auditoria. Nenhum catálogo retorna segredos,
destinatários ou corpos de mensagens processadas.

| Método / caminho (`/api/hub`) | Contrato |
| --- | --- |
| `POST /login`, `/logout` | Reutiliza autenticação/sessão existente; não concede acesso ao Hub |
| `GET /session` | Usuário e tenants explicitamente administráveis |
| `GET /tenants/:tenant/applications` | Aplicações e metadados públicos do remetente, sem BYOK |
| `POST /tenants/:tenant/applications` | `{id,name,senderConfigurationId}`; cria dry-run + catálogo desabilitado + token exibido uma vez |
| `GET /tenants/:tenant/applications/:app` | Catálogo, versões e bindings; limite explícito de 200 itens |
| `POST /tenants/:tenant/applications/:app/catalog` | `{name}`; adoção explícita do catálogo em aplicação existente |
| `POST /tenants/:tenant/applications/:app/templates` | `{id,subject,body,variables:[{name,type:"text" ou "https_url"}]}`; nova versão |
| `POST /tenants/:tenant/applications/:app/bindings` | `{eventType,templateId,templateVersion,enabled}` |
| `POST /tenants/:tenant/applications/:app/preview` | `{templateId,templateVersion,data}`; devolve assunto e texto renderizados, não envia |
| `GET /tenants/:tenant/applications/:app/events?page=0` | 25 resultados/página; estados, tentativas, erros e últimas auditorias de configuração/worker |

Ingestão/status do consumidor continuam em `/api/v1/events`; o contrato não
conhece Resend, credencial de worker ou administração. Cron continua dry-run;
nenhuma API nova executa envio real ou o worker.

## Critérios e autorização operacional

Testes locais usam libSQL real em arquivos temporários. Cobrem isolamento,
revogação, origem, rollback da auditoria, adoção, templates desabilitados,
versionamento/snapshot, escaping, processamento/status/auditoria em dry-run e
ausência de segredos nas respostas. Preview compartilha banco operacional:
testes mutáveis devem usar ponte para fixtures locais, nunca endpoints remotos.

Para autorizar envio real posteriormente, apresentar remetente existente,
destinatário autorizado, assunto/conteúdo renderizados, aplicação/configuração,
allowlist, orçamento e evento **novo**. Simulações terminam em `dry_run`/fila
`cancelled` e nunca são convertidas em envios. Não habilitar flags nesta etapa.

SSO, agendamento avançado, marketing, outros provedores e onboarding universal
continuam adiados. Todoku Mail não é parte desta implementação.
