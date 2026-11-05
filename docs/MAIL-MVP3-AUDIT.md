# MVP 3: auditoria de autenticação e administração

> Entrega 4: a [auditoria de cobertura do painel](MAIL-ADMIN-PANEL.md) confirmou o escopo nas APIs existentes, sem complemento de backend. O diagnóstico histórico abaixo é preservado; quotas agregadas e UX de perfil/sessões continuam em entregas posteriores.

> As entregas 1 e 2 foram publicadas pelas PRs #23/#24, em `85c17e7` e `37e20d4`: [autorização](MAIL-AUTHORIZATION.md) e [APIs administrativas](MAIL-ADMIN-API.md). A entrega 3 acrescenta [usuários, convites e sessões](MAIL-USERS-INVITATIONS.md), com migração aditiva `0008`, para revisão em PR. O diagnóstico abaixo é histórico; painel e quotas agregadas continuam pendentes.

Revisão de 05/11/2026 da [issue #20](https://github.com/mtcporto/todoku/issues/20), após as PRs #21 e #22. OIDC e política de envio estão entregues; administração multiusuário/multidomínio, quotas agregadas e usabilidade ainda precisam de entregas incrementais. O [plano de PRs](MAIL-MVP3-PLAN.md) descreve a proposta, sem implementação ou ampliação de permissões nesta auditoria.

## Inventário conferido

Consulta somente de leitura às 20:24:52 UTC / 17:24:52 de Fortaleza: `main` e `origin/main` em `1fec48a`; banco único `todoku`, migrações `0001`–`0006` aplicadas e checksums iguais aos arquivos. Integridade SQLite `ok`, zero violações de FK. Nenhuma migração, concessão, alteração de quota ou publicação executada nesta revisão.

Os backups e a aplicação anterior de `0005` e `0006` estão documentados nas entregas correspondentes; esta revisão não reaplica essas migrações. O estado histórico da PR #21 está no [registro operacional](MAIL-GOOGLE-OIDC.md#preparação-operacional-em-05112026).

| Camada | Modelo atual | Implicação para o MVP 3 |
| --- | --- | --- |
| Usuário | `mail_users.id` interno, username único, hash scrypt, status | Manter IDs, senhas e status; identidade Google referencia esse ID |
| Sessão | Token aleatório de 32 bytes; SHA-256 no Turso; 12h, revogação/status consultados por request; sem método de login persistido | Reutilizar sessões; acrescentar metadados confiáveis para perfil e ações de sessão |
| Organização | `tenants` e FKs compostas; domínio pertence ao tenant; sem membership ou papéis administrativos | Acrescentar administração da organização/domínio sem conceder conteúdo |
| Source/domínio | Source BYOK por tenant; domínio aponta para source | Autenticação não muda Resend, DNS, sources ou credenciais |
| Caixa | `mail_identities` independente de login; relação muitos-para-muitos por grants já suporta compartilhamento | Preservar IDs; explicitar tipo individual/compartilhada e sua administração |
| Permissões | Existência de `mail_identity_grants` concede leitura; `can_send` e `can_manage` adicionais | Leitura ainda é implícita; administração de domínio não existe como papel separado |
| Conteúdo | Metadados/threads/recipientes Turso; conteúdo, MIME e anexos privados R2 | Não migrar ou regravar conteúdo para trocar o login |
| Envio | `recipient_policy=external` em contato, lista vazia e quota 20/24h; serviço/CLI `updateSendingPolicy` auditado; jobs idempotentes | Reutilizar PR #22; acrescentar orçamento agregado e consumo por destinatário |
| Processamento | Cron autenticado `/api/internal/mail-worker`, a cada 5 minutos; Receiving e Sending com flags independentes | Nenhuma alteração em worker/cron, deduplicação ou Notifications |
| APIs e UI | Rotas autenticadas e compositor separados; filtros de domínio/caixa existentes; Google disponível; logout com seta e rótulo acessível | Reaproveitar UI; faltam administração, perfil e contexto de organização |

O usuário `mtcporto` mantém o ID interno `10a1ff09-52f6-4eee-9c78-ef670893d7ae`, senha e vínculo Google ativo para a conta autorizada. Há um evento de vínculo e dois logins OIDC registrados. O tenant `todoku` possui um domínio ativo e duas caixas: `contato` ativa com envio/gerenciamento, `suporte` desativada sem envio/gerenciamento. Há grants do proprietário para ambas; leitura é implícita pela existência do registro. Existem três registros de usuário na base, mas somente um usuário tem grants no tenant `todoku`; não se deve tratá-los automaticamente como novos membros da organização.

Snapshot do tenant: 10 mensagens, 9 threads, 6 anexos, 18 objetos, 62 eventos de auditoria de Mail, 3 eventos inbound, 1 job outbound aceito e 2 eventos de status. Nenhum dado ou ID foi reinicializado. Não há tabelas de membership, administração, convite ou orçamento agregado.

## Diagnóstico após PRs #21 e #22

| Requisito | Estado | Evidência/lacuna |
| --- | --- | --- |
| Google e senha para o mesmo ID | Pronto para o proprietário | Protocolo e vínculo existentes; entrada Google ainda limita o proprietário configurado, sem onboarding de outros usuários |
| Tenant com vários domínios | Parcial | Schema permite vários; hoje existe um domínio real; não há gestão administrativa |
| Caixas independentes e compartilhadas | Parcial | IDs próprios e grants N:N existem; sem tipo/gestão de caixa no painel |
| Administração organização/domínio/caixa | Ausente | Sem papéis, membership, guards ou APIs administrativas |
| Leitura explícita e administração sem conteúdo | Ausente | Falta `can_read`; uma role administrativa futura não pode ser implementada como grant de caixa |
| Usuários, convites, suspensão e sessões | Parcial | Status global, sessão opaca e revogação existem; operação via scripts, sem convites/painel ou suspensão por organização |
| Envio externo seguro | Pronto | PR #22 e política real `external`, quota 20, rate limit 5/min e 10 destinatários |
| Quotas em camadas e consumo | Parcial | Quota por identidade conta jobs; sem orçamento de organização/domínio, contador faturável ou painel de consumo |
| Perfil e contexto de navegação | Parcial | Username, Google vinculado e seletores já existem; sem menu, método da sessão ou seletor de organização |
| Feedback de permissão/quota | Parcial | Compositor já traduz ausência de envio/quota; leitura costuma retornar erro genérico; caixa inativa não tem tratamento completo |

### Pontos que a primeira PR de autorização deve corrigir

- `identityGrant` exige identidade/domínio/source ativos para enviar; leitura/gestão não têm o mesmo gate de atividade. As consultas de inbox, mensagem e anexo verificam grants e tenant, mas não aplicam uniformemente o estado da caixa/domínio. Desativar uma caixa hoje não é uma revogação completa de leitura. Nenhuma exploração por leitura de conteúdo foi feita nesta auditoria.
- Introduzir `can_read` exige revisar lista, detalhe, anexos, threads, marcar como lido e ações; um novo campo sem esses guards não implementa autorização.
- Rascunhos não registram autoria explícita de usuário no modelo atual; a validação depende do grant de envio da caixa. Separar envio de leitura exige definir o acesso ao rascunho próprio sem conceder leitura da caixa inteira.
- `can_manage` atual gerencia mensagens/pastas; não significa administrar caixa, domínio, usuários ou permissões.
- A suspensão global de `mail_users` não pode ser usada indiscriminadamente por administrador de uma organização, pois atingiria outras organizações futuras. Membership e revogação de acesso precisam respeitar o escopo.
- Sessões não registram método de autenticação. Ter Google vinculado não prova que a sessão atual entrou por Google.
- A UI deriva domínios dos grants de caixa. O futuro administrador sem leitura precisa obter seu escopo de administração por outra API, não por grants de conteúdo.
- `updateSendingPolicy` é um serviço de operador confiável, sem endpoint público. O painel deverá autorizar o administrador antes de chamá-lo.

## Migração aditiva 0005

`0005_mail_oidc.sql` cria:

- `mail_auth_identities`: ID próprio, FK para usuário interno e identidade externa `(provider, issuer, subject)` única; e-mail verificado como atributo e gate do piloto, nunca chave da identidade. Um vínculo por usuário/provedor/issuer impede substituir a conta por coincidência de e-mail.
- `mail_oidc_attempts`: hash de cookie aleatório, hash de state e contexto AEAD com PKCE/nonce/state. Validade de 10 minutos, consumo atômico e único. Contexto vinculado ao hash da tentativa por AAD; expirados são eliminados no próximo início de fluxo.
- `mail_auth_audit_log`: auditoria append-only de vínculo/login/negação de tentativa válida; não contém código de autorização, tokens, segredo, nonce ou conteúdo de provedor.

Não há ALTER/DROP em tabelas existentes, atualização de usuário, associação automática de grants, cópia de mensagens ou alteração de keyring. A finalidade AEAD `oidc_context` é adicional; os envelopes BYOK existentes continuam compatíveis.

O runner existente aplica cada migração numa transação, verifica checksums e não roda durante request/build. Não editar migrações já aplicadas. A PR pode ser publicada com Google desativado **antes** da migração: o login por senha não depende das tabelas novas e o status OIDC só anuncia disponibilidade depois de encontrar `0005` aplicada.

## Matriz de permissões e próxima migração proposta

| Capacidade | Hoje | Direção para a fase 3 (não implementada aqui) |
| --- | --- | --- |
| Autenticar | Senha local; Google vinculado opcional nesta PR | Vários provedores apontam ao mesmo usuário interno |
| Ler caixa/anexos | Grant da identidade; tenant/usuário ativos | `can_read` explícito e caixa ativa, conferidos nas rotas |
| Enviar | Grant `can_send`, identidade/domínio/source ativos e configuração/flag | Preservar verificações e separar política de quotas |
| Gerenciar mensagens | Grant `can_manage` | Distinguir gestão da caixa e ações do conteúdo |
| Administrar domínio | Sem papel/API de administração | Role de domínio/tenant sem leitura implícita de mensagens |
| Administrar usuários e revogar sessões | Scripts operacionais; usuário desativado/sessão revogada negados | Membership/roles e APIs protegidas; suspensão por escopo, sem afetar outra organização |

A migração proposta acrescenta membership, papéis administrativos e leitura explícita, preservando os grants atuais. Um administrador sem `can_read` não poderá abrir conteúdo. O mero vínculo OIDC jamais cria membership ou grant. O [plano incremental](MAIL-MVP3-PLAN.md) detalha rollout, quotas e testes; nenhum desses novos papéis foi aplicado nesta auditoria.

## Segurança e rollback

O primeiro vínculo exige sessão atual do usuário interno configurado, state, cookie efêmero e conta Google com e-mail verificado autorizado. A sessão iniciadora é revalidada na transação depois da troca do código: expiração, revogação ou suspensão impedem o vínculo. O vínculo e a nova sessão são atômicos; a sessão iniciadora é revogada após sucesso. Login posterior exige o `subject` já vinculado; nunca faz fallback para busca por e-mail.

`openid-client` verifica Code + PKCE S256, state, nonce, issuer, audience/azp, expiração e assinatura RS256 via JWKS Google. Os endpoints são fixos e HTTPS, com timeout e redirects de rede recusados pela biblioteca. A resposta volta somente a `/mail` na origem configurada. O cookie temporário é HttpOnly, Secure e Lax para o retorno cross-site; a sessão final preserva HttpOnly, Secure, Strict e prefixo `__Host-`. Scopes apenas `openid email`; não há acesso ao Gmail nem refresh token.

Rollback: desativar `TODOKU_GOOGLE_OIDC_ENABLED` e publicar por GitHub → Vercel. O acesso por senha continua disponível, sem restaurar hashes ou IDs. Se necessário, revogar sessões pelo procedimento já existente antes da retomada. Deixar as tabelas aditivas e a auditoria preservadas; não executar down migration destrutiva nem remover bindings automaticamente. Senhas só devem ser desativadas numa entrega futura, após teste Google real e plano de recuperação aprovado.

## Limite da validação desta entrega

Há testes locais com JWTs RSA assinados e token/JWKS simulados, incluindo troca PKCE, assinatura inválida, claims, replay, concorrência, sessão revogada, CSRF e isolamento. A UI tem contrato automatizado desktop/mobile com APIs interceptadas. Esses testes não substituem um consentimento/login real no Google.

O responsável concluiu o vínculo/login Google no domínio principal depois da PR #21. O Turso confirmou o binding ativo e a auditoria de vínculo/login, preservando o mesmo ID e grants. Esta revisão não repetiu consentimento, login ou testes de envio reais. O último CI da `main` (`42095007156`) foi consultado com sucesso; os testes existentes cobrem a base das PRs #21/#22, mas não substituem os novos testes administrativos ainda necessários.
