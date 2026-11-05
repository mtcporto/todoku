# Mail — usuários, convites e sessões (MVP 3, entrega 3)

Base: `main` em `37e20d4`, após PRs #23/#24. Esta entrega acrescenta a migração `0008_mail_users_invitations_sessions`, reutilizando memberships, papéis, grants e guards da `0007`. A PR permanece para revisão, sem merge. Não há cadastro público, envio automático de convites ou novos grants por autenticação.

## Identidade e onboarding

O UUID de `mail_users` continua sendo a identidade principal. O login Google normal aceita somente um binding ativo de `(issuer, subject)` previamente registrado e um usuário globalmente ativo. Um endereço verificado, isoladamente, nunca seleciona outro usuário interno para vinculação.

- Administrador **de organização**, com membership e papel ativos, emite convite para um endereço normalizado. Administradores de domínio/caixa não convidam membros para a organização.
- Token aleatório de 256 bits, uso único, validade padrão de 24 horas (configurável entre 1 e 168 horas). Somente SHA-256 é persistido; até 100 convites pendentes e ainda válidos por organização.
- O link completo é devolvido uma única vez, com token no fragmento `/mail/invite#…`. A página remove o fragmento do histórico ao carregar, conserva o token apenas em memória e o envia por POST ao iniciar OIDC. Não usa query string, armazenamento local ou envio de e-mail. Recarregar exige reabrir o link original.
- Google usa o mesmo Code + PKCE S256, assinatura RS256, issuer/audience, nonce, state, cookie de tentativa e prazo do protocolo existente. Scopes continuam apenas `openid email`, sem Gmail/offline/refresh token. O contexto criptografado guarda o ID do convite, nunca seu token original.
- Após verificar a conta Google, a aceitação revalida convite, prazo, tenant, papel do emissor, sessão iniciadora quando existente e conflitos de binding **dentro da transação de escrita**.
- Se o subject já estiver vinculado, reutiliza seu UUID. Para convidar um usuário interno sem Google vinculado, informar `userId` e exigir login por senha desse usuário antes da aceitação. A página permite entrar por senha em outra aba. Também pode reutilizar a sessão autenticada do próprio destinatário num convite sem alvo explícito; não troca para outro usuário por e-mail.
- Se não houver binding, alvo interno ou sessão iniciadora, cria UUID e username internos novos. A senha recebe marcador não autenticável `!google-only`; não há senha padrão, cadastro público ou reset nesta entrega. Usuários existentes conservam seus hashes e fallback por senha.
- Binding incompatível, usuário global desativado ou membership suspensa impedem o onboarding. Convite não reativa membership suspensa; o administrador deve usar a API auditada existente.
- Aceitar cria apenas membership ativa, quando inexistente. **Não cria papéis administrativos, grants de leitura/envio/gerenciamento ou caixas.** Um membro sem grants entra autenticado e vê uma inbox sem caixas acessíveis.
- Consumo, vínculo, criação eventual de usuário/membership, auditoria e sessão são atômicos. Corrida entre dois callbacks produz uma única aceitação. Falha de auditoria desfaz o onboarding.

Para o proprietário configurado, mantém-se adicionalmente o gate do endereço Google verificado original. Para outras pessoas, convites e bindings explícitos substituem a restrição global ao proprietário. O estado External/Testing e os usuários de teste do cliente Google continuam sendo uma restrição independente do provedor; **não foram alterados**. Um convidado fora da audiência permitida no Google não conseguirá consentir até ajuste autorizado no Console.

## APIs de convites

Todas exigem autenticação e administração organizacional no tenant indicado. Mutações exigem Origin permitido, entradas estritas e revalidação transacional. Respostas `no-store`; não retornam credenciais ou conteúdo de e-mails.

| Método/caminho                                          | Contrato                                                                                                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET `/api/mail/admin/organizations/:tenant/invitations` | `{items,nextCursor}`; `limit` 1–100, padrão 50, `cursor` ID. Retorna ID, e-mail convidado, alvo interno opcional, emissor, datas, estado efetivo e usuário que aceitou. Nunca hash/token/link reutilizável                  |
| POST no mesmo caminho                                   | `{email,userId?,expiresInHours?}` → 201 `{id,expiresAt,invitationUrl}`. O link deve ser compartilhado manualmente pelo administrador                                                                                        |
| POST `…/invitations/:id/revoke`                         | Corpo vazio ou `{}`; revoga pendente, idempotente em estado terminal. Aceito retorna 409 e não suspende o usuário                                                                                                           |
| POST `…/invitations/:id/expire`                         | Mesmo contrato, encerramento administrativo por expiração                                                                                                                                                                   |
| POST `/api/mail/oidc/google/invite`                     | `{token}`; inicia onboarding Google. Com `Accept: application/json`, devolve `{authorizationUrl}` e cookie HttpOnly de tentativa; caso contrário, redireciona. Não aceita ID interno/e-mail/papel fornecidos pelo convidado |

Convites vencidos aparecem como expirados mesmo antes de atualização física. Nova emissão para o mesmo endereço encerra e audita o pendente vencido. Duplicata ainda válida retorna 409. Revogação não afeta convites de outro tenant. Falha de aceitação mostra erro genérico no login, sem publicar claims ou detalhes privados.

## Sessões e suspensão

`mail_sessions.session_id` é um identificador opaco público, separado do hash do segredo do cookie. Novas sessões registram `auth_method=password|google`. Sessões anteriores e sessões emitidas pelo servidor anterior registram **legacy**, pois seu método não pode ser inferido com segurança. A existência de binding Google não muda o método da sessão atual.

| Método/caminho                       | Contrato                                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET `/api/mail/session`              | Preserva `{user,administration}` e acrescenta `session:{id,method,createdAt,expiresAt}`                                                                                              |
| GET `/api/mail/sessions`             | Somente sessões do próprio usuário; `{items,nextCursor}`, `limit` 1–100, `cursor` ID; ID, método, criação, expiração, revogação e indicador `current`. Sem hash/token/IP/fingerprint |
| POST `/api/mail/sessions/:id/revoke` | Apenas sessão do próprio usuário, Origin e corpo estrito vazio/`{}`. Revogação auditada e idempotente; ao revogar a atual, limpa o cookie. Sessão de terceiro retorna 404            |

Sessões expiradas/revogadas continuam sujeitas à retenção já existente. Auditoria de revogação preserva ID, ator, data e indicação da sessão atual, sem segredo do cookie. As rotas existentes continuam revalidando sessão e estado global do usuário.

Administrador organizacional suspende/reativa **membership**, pelas APIs da PR #24, sem revogar a sessão global nem bloquear outras organizações. Os guards aplicam a suspensão também nas APIs de conteúdo e administração. A proteção do último administrador permanece ativa. Desativação global de `mail_users` continua sendo operação de operador confiável, sem endpoint irrestrito para administrador de tenant. Não se introduz capacidade administrativa global nesta PR.

## Migração, rollout e recuperação

`0008` acrescenta IDs/método de sessão, detalhes JSON à auditoria de autenticação e tabela/índices de convites. Preserva todos os campos antigos. Um trigger atribui ID às sessões inseridas pelo servidor anterior, que desconhece as colunas novas. Não altera `0007`, grants, roles, senhas, credenciais BYOK, mensagens ou anexos.

**Aplicar 0008 antes de executar o novo servidor**, inclusive Preview. Antes: exportar backup privado do banco único `todoku`, checkpoint, SHA-256 e integridade/FKs; migrar somente uma cópia de validação, comparar todas as colunas existentes e testar idempotência. Depois aplicar uma vez ao remoto e repetir comparação/integridade. Não rodar migração durante build/request.

Evidência desta execução: backup privado `todoku-before-users-20261105-pr3.db`, SHA-256 `7fd72257b390028372995ff86943f69bd9065cb5dc1a57ba9ac9267c9af9c3d2`. A cópia migrada e o remoto preservaram os dados das 36 tabelas anteriores, com integridade `ok` e zero violações de FK. Aplicação remota única às `2026-11-05T21:59:20.206Z`, checksum `b602321257e34e51e04d4c6cc0c2fb16e4344f3390c9f397220c99b190e1bd9e`. Zero usuários, convites ou grants criados. A publicação automática do Preview e as evidências sanitizadas são registradas na issue #20.

Publicar somente por GitHub → Vercel. Deixar a PR aberta para revisão. Não emitir convites reais nem conceder acessos durante a validação desta entrega. Depois do merge e deployment correspondente READY, o futuro painel poderá consumir estas APIs; usuários novos nunca devem depender do servidor antigo para login Google.

Recuperação: interromper emissão/aceitação de convites se houver falha; se necessário desativar OIDC, preservando acesso por senha. Uma correção deve manter os guards `can_read` e os dados/auditoria. O servidor da PR #24 é compatível com o schema aditivo, mas não aceita os novos usuários Google convidados; preferir correção para frente após onboarding real. Não executar down migration ou restaurar o banco em uso como rotina.

## Validação e limites

Testes isolados cobrem emissão, expiração/revogação/replay, subject versus e-mail, prova do usuário existente, ausência de grants, suspensão por organização, revalidação da sessão, falha de auditoria, concorrência com conexões independentes, compatibilidade da migração e métodos/revogação de sessões. A suíte anterior continua cobrindo envio, recebimento, grants e isolamento.

`npm run smoke:mail:invitations` valida desktop/mobile, token fora de URL HTTP/DOM/storage, erros, sessão existente, teclado e handoff sintético Google. APIs são interceptadas; não emite convite real nem substitui um consentimento Google real. O Preview usa leitura administrativa, login/logout do proprietário e a página de convite sem criar pessoas/grants. Não se declara onboarding Google externo real como validado por esses testes.

Quotas permanecem 20 mensagens/24h. Não há alterações de DNS, Resend, Sending, Receiving, Notifications ou estado das caixas existentes. Painel administrativo, gestão visual de sessões/perfil e quotas agregadas permanecem nas próximas entregas.
