# MinhaNota → Todoku Hub — piloto operacional

## Escopo em 06/11/2026

Primeira integração do Communication Hub, somente para boas-vindas após login
Google no MinhaNota. O responsável autorizou em um único lote a preparação
operacional, credencial exclusiva, variáveis de Production, merge da PR #3 e
teste controlado em dry-run. Essa autorização não libera entrega externa.

- Todoku: documentação de inicialização integrada na [PR #33](https://github.com/mtcporto/todoku/pull/33),
  commit `bfc7de764d033f44874187a90291ebc5c7c45383`, Production READY.
- MinhaNota: [PR #3](https://github.com/mtcporto/minhanota/pull/3) revisada no head
  `92f51218a49eaa2d4685ec1a850c241a339ecdc6`, integrada por squash em
  `797886c6f8d556d3710d7cb58f3fd58819f3c57b`.
- Deployment automático `dpl_21v7oTCtdofoGBD9sZUeshwCryKE`, READY; alias
  `https://minhanota.app` e ID do deployment no HTML conferidos.
- [CI da main](https://github.com/mtcporto/minhanota/actions/runs/42249224823)
  aprovado. Cinco testes do consumidor, typecheck, build e smoke integrado
  local com dois bancos isolados também aprovados antes da publicação.

## Configuração do Hub

| Campo | Valor |
| --- | --- |
| Tenant / aplicação | `todoku/minhanota` |
| Nome | `MinhaNota` |
| Remetente | `MinhaNota <notificacoes@minhanota.app>` |
| Modo | `dry_run` |
| Configuração Hub | `0abab748-94c0-4aa8-b408-cb3ac71e4be6` |
| Template / versão | `minhanota.welcome@1` |
| Assunto | `Boas-vindas ao MinhaNota` |
| Variável obrigatória | `firstName`, texto |
| Única comunicação habilitada | `user.welcome` |
| Verificação de e-mail, recuperação e alerta de segurança | Desabilitados |
| Credencial de ingestão | Exclusiva, escopo `events:write`; somente hash no Turso |
| Chave Resend / segredo de webhook na configuração nova | Ausentes |

Texto do template: `Olá, {{firstName}}! Sua conta MinhaNota está pronta. Acesse https://minhanota.app para começar.`

O tenant não tinha configuração de remetente para cadastrar sua primeira
aplicação pelo painel. O cadastro inicial autorizado usou transação com
`requireHubAdministrator` revalidando a sessão/UUID/tenant e `hubAudit` para
aplicação e credencial. Não reutilizou configurações revogadas ou de outro
tenant. Somente metadados de remetente foram registrados, sem criar domínio,
chave ou configuração no Resend.

A adoção do catálogo usou a API administrativa autenticada existente, com nome
`MinhaNota`. Template, associação de evento e prévia foram configurados pelo
painel publicado em sessão isolada, com igualdade entre confirmação e payload
conferida. Desktop e celular verificados. Não houve mudança de backend,
autenticação ou migração; 0009 e bootstrap do administrador não foram repetidos.

## Variáveis e credencial

Somente no projeto Vercel **minhanota**, target **Production**:

| Variável | Configuração |
| --- | --- |
| `TODOKU_ORIGIN` | `https://todoku.com.br` |
| `TODOKU_TENANT_ID` | `todoku` |
| `TODOKU_APPLICATION_ID` | `minhanota` |
| `TODOKU_APPLICATION_TOKEN` | Secret/Sensitive, sem valor neste documento |
| `MINHANOTA_TODOKU_ENABLED` | `true` |

O opt-in permaneceu `false` até Hub, template, credencial e destinatário elegível
serem conferidos. Foi habilitado antes do merge, de modo que a publicação
automática recebesse as variáveis. Preview e Development não receberam essas
cinco variáveis. Nenhum deploy manual ou redundante foi executado.

O token foi passado diretamente, em memória, por stdin ao CLI autenticado da
Vercel. Não foi escrito em arquivo, commit, screenshot ou log. Uma validação do
formato da resposta no cliente falhou depois da criação; consulta remota
confirmou a variável Sensitive e seu target antes de prosseguir. Não foi criada
segunda credencial nem repetida a criação da variável.

## Reconferência inicial e bloqueio histórico

Em 06/11/2026, a continuação consultou as duas branches locais e a `main` no
GitHub, metadados autenticados da Vercel, health HTTP e os dois bancos, somente
em leitura. Nenhuma configuração foi repetida:

- Todoku `main` em `bfc7de764d033f44874187a90291ebc5c7c45383`;
  deployment `dpl_CU7c12ahZownypDBamuQY3yc9DV9`, READY.
- MinhaNota `main` em `797886c6f8d556d3710d7cb58f3fd58819f3c57b`;
  deployment `dpl_21v7oTCtdofoGBD9sZUeshwCryKE`, READY, também identificado
  no HTML de `https://minhanota.app` (HTTP 200).
- `https://todoku.com.br/api/health`: HTTP 200, `ready`, ingestão `durable`,
  entrega padrão `dry_run`, marketing `disabled`.
- 0009 presente; tenant/aplicação ativos; configuração acima ativa em
  `dry_run`, `send_count=0`, sem chaves de envio/webhook.
- Conteúdo, assunto e variável `firstName` do template conferidos no banco;
  somente o binding `user.welcome` habilitado.
- As cinco variáveis do consumidor continuam exclusivamente em Production;
  origem/tenant/aplicação correspondem à tabela acima, opt-in `true`.
- Duas linhas em `emails_boas_vindas`, zero em `emails_boas_vindas_hub`;
  zero eventos em `todoku/minhanota`. Nenhuma reserva ou histórico alterado.

| Trecho | Estado na reconferência inicial, antes da autorização adicional | Evidência necessária |
| --- | --- | --- |
| API → Todoku Hub | **Bloqueado; não validado** | HTTP autenticado 202, snapshot, processamento dry-run, status, auditoria e replay |
| Login Google → MinhaNota → Todoku Hub | **Pendente; não validado** | Login legítimo e reserva/recibo do consumidor correlacionados ao evento do Hub |

O contrato existente permite `POST /api/v1/events` com `type=user.welcome`,
`tenantId=todoku`, `applicationId=minhanota`, destinatário autorizado e
`data={"firstName":"Teste"}`. A supressão de boas-vindas legadas ocorre no
consumidor, não nesse endpoint. Dry-run não exige allowlist de transporte;
isso não dispensa autorização do destinatário pelo responsável.

**Bloqueio de credencial:** a leitura autenticada da variável existente
`TODOKU_APPLICATION_TOKEN` com `decrypt=true` devolveu metadados Sensitive,
sem valor utilizável. Não há cópia em `.env.local` do MinhaNota. Nenhum token
foi gerado, rotacionado ou exposto. O responsável estava indisponível para
fornecer acesso privado à credencial ou autorizar alternativa. Não foi feito
POST de ingestão; health e consultas SQL não substituem essa prova.

## Validação API → Hub concluída em Production

Após o bloqueio acima, o responsável autorizou explicitamente credencial
temporária `events:write` restrita a `todoku/minhanota`, destinatário próprio
exclusivamente dry-run e revogação após o teste. A execução de 06/11/2026
ocorreu entre **19:18:38Z e 19:20:58Z**; não reutilizou nem alterou a
credencial Production do MinhaNota.

| Evidência | Resultado |
| --- | --- |
| Origem / contrato | HTTP real `https://todoku.com.br/api/v1/events`, `user.welcome`, transactional, `data.firstName=Teste` |
| Evento persistido | `201f7b21-e24a-4f79-8fd2-b3ba80686c98` |
| ID de origem | `18ff5c00-0ce6-4bd1-8c08-72ab4bf3554e` |
| Idempotency key exclusiva | `minhanota-api-validation-1cf7c2a7-64f2-4bb2-b37b-686a04541bd0` |
| Aceite | HTTP 202, `status=accepted`, `replay=false` |
| Replay idêntico | HTTP 202, mesmo eventId, `replay=true`; uma outbox e uma auditoria de aceite |
| Isolamento da credencial | Payload com outro tenant rejeitado por HTTP 403 `scope_mismatch`, sem criar evento |
| Persistência | Payload canônico e SHA-256 iguais ao request; evento, outbox e snapshot correlacionados |
| Snapshot | `minhanota.welcome@1`, configuração `0abab748-94c0-4aa8-b408-cb3ac71e4be6`, modo `dry_run`; destinatário autorizado, remetente, assunto e conteúdo renderizado conferidos |
| Outbox | `8827e29b-50da-4a75-94f6-2dd3ae77a41f` |
| Processamento | Cron agendado de Production, sem invocação local/manual do worker |
| Tentativa | Uma, `provider=dry_run`, `status=succeeded`, de `19:20:43.366Z` a `19:20:43.597Z` |
| GET de status | HTTP 200; `queueStatus=cancelled`, `deliveryState=dry_run`, `mode=dry_run`, `attempts=1`, `error=null`, `providerMessageId=null` |
| Auditoria de ingestão | Uma ação `event.accepted`, vinculada à credencial temporária |
| Auditoria de processamento | `claimed` em `19:20:43.455Z`; `dry_run` em `19:20:43.683Z` |
| Entrega externa | Nenhum ID de provedor; `budget_reserved=0`; configuração sem chave Resend/webhook e `send_count=0` |

### Expiração, revogação e preservação

- Credencial temporária: `50b73e16-dada-4a1a-ad38-8b03d3f2b64b`,
  somente `events:write` no escopo autorizado; expiração prevista
  `2026-11-06T19:33:38.436Z` (15 minutos).
- Criada com o guard administrativo existente, revalidado na transação;
  auditoria `credential.created` em `19:18:43.388Z`.
- **Revogada em `2026-11-06T19:20:56.581Z`**, com auditoria
  `credential.revoked` em `19:20:56.708Z`. GET de status e POST do payload
  idêntico após revogação retornaram **401 `unauthorized`**.
- Token gerado apenas em memória; somente hash no banco. Nenhum token
  Production ou variável Vercel alterado; demais credenciais comparadas
  integralmente antes/depois, sem diferenças. Sessão administrativa
  temporária encerrada.
- Configuração de provedor, templates e bindings comparados integralmente
  antes/depois, sem diferenças. Duas boas-vindas legadas e zero reservas Hub
  do MinhaNota mantidas, com contagens e digests iguais. Nenhum histórico
  apagado ou atualizado para produzir esse evento.
- Relatório privado sem token/payload pessoal:
  `.vercel/minhanota-pilot-20261106/api-validation-20261106.private.json`.
  As referências acima permitem conferir o resultado diretamente no banco.

| Trecho | Estado após o teste direto API, antes do login Google |
| --- | --- |
| **API → Todoku Hub** | **Validado em Production, exclusivamente dry-run** |
| **Login Google → MinhaNota → Todoku Hub** | **Pendente; não validado por este teste** |

Não houve alteração de backend, nova implementação de envio, migração,
DNS/Resend ou liberação de envio real. A fila `cancelled` é o estado terminal
esperado da simulação, não erro nem confirmação de entrega externa.

### Procedimento de referência para novos testes autorizados

1. Disponibilizar a credencial existente somente em memória/arquivo privado
   fora do Git, nunca no chat/log. Confirmar o destinatário autorizado.
   Se não houver cópia, solicitar autorização específica antes de criar uma
   credencial temporária restrita, com expiração e revogação ao final; não
   substituir o token Production do consumidor.
2. Reconfirmar configuração ativa dry-run e template. Gerar UUID/instante e
   chave própria, como `minhanota-api-validation-<UUID>`, sem usar a chave
   `minhanota-welcome-<hash>` do consumidor. Preservar o mesmo payload para
   retries; não escrever nas tabelas de boas-vindas do MinhaNota.
3. Fazer o POST na origem Production e exigir 202. Repetir o payload idêntico,
   exigindo o mesmo `eventId`, `replay=true` e apenas uma outbox/auditoria.
4. Conferir payload persistido, snapshot `minhanota.welcome@1`, remetente,
   assunto/conteúdo renderizado e modo. Aguardar cron dry-run; conferir GET de
   status, fila terminal `cancelled`, entrega `dry_run`, tentativa
   `provider=dry_run` bem-sucedida, auditorias de aceite/processamento,
   ausência de ID de provedor e orçamento reservado zero.
5. Somente após essas provas, registrar **API → Todoku Hub validado**.
   Manter **login Google → MinhaNota → Todoku Hub pendente**.

### Alternativa anterior para o callback Google

Usar outra conta Google **já existente e verificada**, disponível e com
consentimento de sua titular, sem histórico/reserva de boas-vindas. Conferir
elegibilidade em leitura antes de login legítimo pelo navegador. O código
permite sessão sem empresas autorizadas: não criar contas fiscais, adicionar
à lista de acesso, vincular CNPJ ou conceder papéis/grants. Não fabricar tokens,
códigos OAuth ou callbacks. Sem participante elegível disponível, essa
validação continua pendente.

Até essa etapa, contas com boas-vindas antigas permaneciam suprimidas. Nenhuma reserva ou sucesso
legado havia sido apagado para provocar novo evento. O código já aceita login de uma
conta Google verificada sem acesso fiscal; a lista de contas da Pixel Vivo é
uma permissão de conteúdo, não exigência para o piloto de comunicação. Não
foram alterados autenticação, vínculos de empresas ou grants fiscais.

Depois do login autorizado, conferir a reserva durável
`emails_boas_vindas_hub` no MinhaNota, aceite autenticado e snapshot no Hub,
template/versionamento, tentativa dry-run, auditoria e replay do mesmo payload.
Não substituir a prova do callback por chamada local do consumidor ou evento
controlado diretamente no Hub. O teste direto pode comprovar somente API → Hub.
O teste local de perda do recibo continua evidência separada.

## Continuação: Google → MinhaNota → Hub validado em dry-run

Em 06/11/2026, às 18h47 (UTC−03), o responsável autorizou explicitamente
usar apenas sua conta Google e remover/reinicializar somente as boas-vindas
de desenvolvimento necessárias. Essa autorização substitui, para essa conta
de teste, a orientação anterior de não tocar na supressão legada.

Reconferidos os dois repositórios e deployments Production: mesmos commits
`bfc7de7`/`797886c`, READY. O callback publicado chama o módulo Todoku;
esse fluxo não contém envio direto/fallback Resend. Credencial Production
ativa, variáveis corretas, `user.welcome` como único binding habilitado e
`minhanota.welcome@1` presente. O valor Sensitive não foi extraído; o uso
efetivo dessa credencial pelo consumidor foi confirmado pela auditoria do
evento de callback, como descrito abaixo.

### Preparação executada

- Antes: uma linha legada da conta autorizada, nenhuma reserva Hub da
  conta e nenhum evento com sua chave determinística `minhanota-welcome-*`.
- Em `2026-11-06T21:49:05.604Z`, removida **somente essa linha legada**,
  filtrando e-mail exato e `criado_em` original, em transação. Não foi
  necessário apagar/reinicializar reserva Hub.
- Outras boas-vindas comparadas antes/depois e preservadas. Nenhum outro
  usuário, empresa, documento ou tabela fiscal alterado. As regras de
  idempotência e o evento API anterior permanecem intactos.
- Relatório privado com estado anterior:
  `.vercel/minhanota-pilot-20261106/google-test-reset-20261106.private.json`.
- Preparação concluída; após o login, a reserva Hub foi criada pelo próprio
  consumidor e deve permanecer para suprimir duplicações.

### Login Google real e segundo login sem duplicação

Aberto `https://minhanota.app`, acionado **Entrar com Google** e selecionada
exclusivamente a conta autorizada. O Google inicialmente exigiu senha; foi
solicitada intervenção pessoal, sem receber segredos pelo chat. Durante as
verificações seguintes, o titular concluiu o login no navegador.

| Evidência do callback em Production | Resultado |
| --- | --- |
| Sessão real no navegador | HTTP 200 em `/api/auth/sessao`, autenticada, conta autorizada, método `GOOGLE_OAUTH`, `iat=1794001796` |
| Reserva durável do consumidor | Uma linha Hub; payload original e `event_id`/`aceito_em` presentes |
| Aceite registrado pelo MinhaNota | `2026-11-06T21:49:57.924Z` |
| Evento Hub | `1e276d31-326b-4e50-886d-2c9c452a46e2` |
| ID de origem | `5c68b98a-d69a-4bb1-8d30-aaf536405b97` |
| Outbox | `830e2a0c-55fc-4847-850c-cc711e12df80` |
| Correlação | Payload canônico e SHA-256 iguais ao payload reservado; mesma chave determinística e mesmo `event_id` |
| Credencial usada no aceite | Credencial Production original `53325eda-ca9c-48ea-8831-ce2519b62e6f`, não a temporária do teste API |
| Template/snapshot | `minhanota.welcome@1`; destinatário autorizado, remetente, assunto e texto renderizado conferidos |
| Processamento | Cron Production; uma tentativa `provider=dry_run`, `status=succeeded`, de `21:50:43.411Z` a `21:50:43.687Z` |
| Estado final persistido | Fila `cancelled`, entrega `dry_run`, uma tentativa, orçamento reservado zero, sem ID de provedor/erro |
| Auditoria de ingestão | Uma ação `event.accepted` em `21:49:57.851Z`, vinculada à credencial Production |
| Auditoria de processamento | `claimed` em `21:50:43.514Z`; `dry_run` em `21:50:43.806Z` |

Foi executado **Sair → Entrar com Google → selecionar a mesma conta**,
sem limpar a reserva. A navegação retornou ao MinhaNota; a ferramenta de
clique excedeu seu timeout ao aguardar a transição, mas a consulta posterior
confirmou nova sessão real `GOOGLE_OAUTH`, `iat=1794002054`, mesma conta.
Não foi necessário repetir o clique ou fabricar callback.

Após o segundo login: mesmo payload (digest igual), mesmos IDs e
`aceito_em`, somente **um evento, uma outbox, uma tentativa e uma auditoria
de aceite** para a chave do consumidor. Nenhuma credencial nova ou mudança
de código foi necessária. A regra geral de idempotência não foi alterada.

Relatório privado sem payload pessoal:
`.vercel/minhanota-pilot-20261106/google-callback-20261106.private.json`.

| Trecho | Estado atual |
| --- | --- |
| API → Todoku Hub | Validado em Production dry-run pelo teste direto anterior |
| **Google → MinhaNota → Todoku Hub** | **Validado em Production dry-run pelo callback real** |
| Segundo login Google / duplicação | Validado: reserva preservada, sem evento/outbox/tentativa duplicados |
| Entrega real | Pendente de confirmação específica e validação do transporte; não habilitada |

### Escopo de envio real avaliado, não ativado

Os controles atuais permitem um teste sem nova implementação de envio:

1. Somente `todoku/minhanota`, evento `user.welcome`, template
   `minhanota.welcome@1`; manter os demais bindings desabilitados.
2. Remetente `MinhaNota <notificacoes@minhanota.app>`, somente o destinatário
   autorizado, allowlist exata e orçamento atômico de **uma mensagem**.
   Assunto `Boas-vindas ao MinhaNota`; corpo do template já documentado,
   com o nome confirmado antes da autorização.
3. Configuração de transporte `test` restrita à aplicação. Verificar domínio
   já cadastrado/validado e credenciais/webhook compatíveis antes de propor
   qualquer alteração; não reutilizar por inferência a chave do Mail nem
   criar DNS, domínio ou provedor. A configuração atual é dry-run e não tem
   chave de envio/webhook. A chave legada `RESEND_API_KEY` ainda cadastrada
   no MinhaNota foi consultada somente em memória: GET de domínios retornou
   **401**. Isso não comprova domínio verificado nem transporte funcional;
   não presumir a causa do 401. A aba Resend foi aberta e exige login do
   responsável; não foram alterados recursos no provedor.
4. O endpoint existente exige `TODOKU_TEST_SEND_ENABLED=true` em Production
   e POST autenticado com `configurationId` explícito. Essa flag é global,
   **não por evento**; o worker limita o claim à configuração indicada e
   o cron GET continua exclusivamente dry-run. Foram encontradas **zero**
   configurações reais de teste ativas. Revalidar isso na confirmação.
5. Novo evento com chave exclusiva para teste real, sem converter snapshot
   dry-run nem remover sua reserva para recriar a chave determinística do
   consumidor. Se o evento real for submetido diretamente à API, registrar
   essa origem separadamente do teste de callback.
6. Após a confirmação específica e execução: conferir status/auditoria,
   recibo/webhook/consulta ao provedor e recebimento na caixa do titular;
   restaurar bloqueio global e configuração dry-run, preservando evidências.

**Nada desse escopo foi ativado.** Após comprovar callback e segundo login,
foram apresentados remetente, destinatário, assunto, texto renderizado e as
mudanças necessárias (incluindo publicação/restauração da flag via
GitHub/Vercel) para confirmação. O titular estava indisponível para responder;
**não houve autorização adicional**. Autorização para preparar a conta não
foi interpretada como autorização para enviar. Nenhum recurso adicional de
envio foi criado. A próxima etapa é confirmação do escopo e acesso ao Resend
existente para validar domínio/credenciais; depois executar e conferir uma
única entrega, inclusive na caixa do titular, e restaurar dry-run/bloqueio.

## Primeiro envio real — concluído

Em 06/11/2026 às 19h11 (UTC−03), o responsável autorizou explicitamente
uma mensagem real pelo Hub, com destinatário próprio, remetente e template
já confirmados, novo evento pela API e conferência Todoku → Resend → Gmail.

- Domínio existente `minhanota.app` conferido no painel e API de gerenciamento:
  `verified`, Sending `enabled`, Receiving `disabled`. Nenhum DNS alterado.
- Reutilizada a chave de **Sending access** já existente do MinhaNota,
  correspondente à variável legada do consumidor. Token e variáveis
  existentes não foram rotacionados nem expostos.
- Chave de gerenciamento temporária criada somente para configuração e
  reconciliação; segredo mantido criptografado, sem log ou arquivo em claro.
- Configuração `test` restrita:
  `583d6327-926d-4b87-8720-ec58f8dff855`; orçamento uma mensagem, um destinatário.
  Configuração dry-run anterior preservada para restauração; outras
  configurações não alteradas. Nenhuma outra configuração `test` ativa.
- Webhook dedicado:
  `ca7db27c-a397-4938-8fe5-7c6ef01c3a0b`, endpoint existente do Hub associado
  à configuração acima; segredo criptografado no mecanismo BYOK existente.
- Janela publicada automaticamente via GitHub/Vercel pela PR #34,
  commit `30aa8647062db92e9cb355ac5e734501601c2b11`,
  deployment Production `dpl_2DdCuSjeqpX5nM6syxDP9RM17QPf` READY.
  Nenhum envio direto pela API do Resend.

### Evidências correlacionadas

| Evidência | Resultado |
| --- | --- |
| Novo POST autenticado `user.welcome` | HTTP 202; evento `0fbd5888-fde4-4741-b594-0bdf03b1f5c4`, chave exclusiva de teste; não reutilizou o evento dry-run |
| Persistência e template | Outbox `2be6a14a-560a-4751-8aac-113edf4dc2b5`; snapshot `minhanota.welcome@1`, conteúdo conferido com a mensagem no provedor |
| Worker publicado | POST restrito à configuração autorizada; uma tentativa Resend bem-sucedida; orçamento `send_count=1` de `send_limit=1` |
| Resend | Mensagem `01a1b2f1-a21e-7481-8ef5-23ffadff4fa1`, criada em `2026-11-06T22:19:02.706Z`, `last_event=delivered` |
| Webhooks assinados | `email.sent` processado às `22:19:04.684Z`; `email.delivered` às `22:19:06.772Z` |
| Status do Hub | `queueStatus=sent`, `deliveryState=delivered`, `attempts=1`, mesmo ID do provedor, sem erro |
| Gmail autorizado | Uma mensagem na Caixa de entrada às 19h19 (UTC−03), remetente e assunto esperados; conteúdo renderizado do template conferido |
| Idempotência | Replay HTTP 202 com mesmo evento e `replay=true`; segunda chamada do worker `processed=0`; uma aceitação auditada e uma tentativa |

O Google → MinhaNota → Hub foi provado anteriormente com login real,
reserva/recibo e segundo login sem duplicação **em dry-run**. Esta nova prova
comprova **API → Hub → Resend → Gmail**, não um login Google com entrega real.
As provas são distintas e, juntas, encerram o piloto; não autorizam envio
contínuo, novas aplicações ou novos destinatários.

### Encerramento e controles

- Configuração real `583d6327-926d-4b87-8720-ec58f8dff855` revogada após
  consumir exatamente uma mensagem. Original
  `0abab748-94c0-4aa8-b408-cb3ac71e4be6` restaurada integralmente em dry-run,
  com auditoria administrativa; digest das outras configurações inalterado.
- Credencial temporária `events:write` revogada e rejeitada por HTTP 401.
  Chave temporária de gerenciamento Resend excluída e rejeitada por HTTP 400
  `validation_error: API key is invalid`; chave Sending existente preservada.
- Somente o webhook dedicado do teste foi desativado após a reconciliação.
  Seus eventos e evidências permanecem preservados; hooks do Mail inalterados.
- Flag Production ajustada para `TODOKU_TEST_SEND_ENABLED=false`; esta PR
  publica a restauração pelo fluxo automático GitHub/Vercel. Conferir READY,
  health e POST do worker bloqueado com `403 test_sending_disabled`.
- Token/variáveis do consumidor e sua reserva Hub não alterados. Nenhum
  histórico apagado nesta prova, nem DNS, Receiving, fiscal ou quotas alterados.
- Relatório privado correlacionado:
  `.vercel/minhanota-pilot-20261106/real-delivery-20261106.private.json`.
  Destinatário, payload e segredos não são publicados nesta documentação.

## Backup, preservação e recuperação

Antes das alterações foram exportados os bancos `todoku` e `minhanota`; DB e
WAL de cada exportação foram restaurados juntos em cópias locais. Integridade
ok, FKs sem violações e digests/contagens de todas as tabelas iguais aos bancos
selecionados (43 no Todoku e 6 no MinhaNota). Os originais foram conferidos por
SHA-256 e mantidos privados em `.vercel/minhanota-pilot-20261106/`, com ACL restrita
à conta executora e fora do Git. Preservar cada par **DB + WAL**, não só o DB.

Relatórios de configuração e imagens do painel ficam nesse diretório privado.
Não publicar destinatário, nome do participante, payload pessoal ou segredo.
O armazenamento de reservas do consumidor contém dados pessoais e exige os
mesmos controles de acesso/retenção do banco operacional.

Em falha, desabilitar o opt-in de Production e publicar pelo fluxo GitHub/Vercel
autorizado; manter a configuração Hub em dry-run, preservar auditoria/reservas
e investigar antes de retomar. Não fazer fallback Resend, apagar recibos,
reaplicar migrações ou restaurar o banco inteiro sobre atividade posterior.
Restauração remota exige procedimento e aprovação próprios.

Fiscal, certificado A1, ADN/SEFIN, DNS, Cloudflare e plano contratado
permanecem fora desta operação. A única exceção Resend foi o teste restrito
autorizado acima; o Mail conserva sua política independente.
Qualquer primeiro envio externo exige autorização e evento novos; um evento
dry-run não deve ser convertido em entrega real.
