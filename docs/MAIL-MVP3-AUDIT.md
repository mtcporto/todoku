# MVP 3: auditoria e primeira entrega de autenticação

Escopo desta PR: fases 1 e 2 da [issue #20](https://github.com/mtcporto/todoku/issues/20). Administração, mudança dos limites de envio e SSO central ficam para entregas posteriores. O Google começa **desativado** e o login atual permanece operacional.

## Inventário conferido

Inventário inicial em 05/11/2026, 15:57 UTC: banco único `todoku`, migrações `0001_durable_ingestion` a `0004_mail_outbound` e checksums iguais ao repositório. Na preparação autorizada, às 18:12:26 UTC, `0005_mail_oidc` foi aplicada após backup e validação local. Os dados das 30 tabelas anteriores permaneceram iguais e não houve violações de FK. O [registro operacional](MAIL-GOOGLE-OIDC.md#preparação-operacional-em-05112026) contém evidências e o hash do restore point privado.

| Camada | Modelo atual | Implicação para o MVP 3 |
| --- | --- | --- |
| Usuário | `mail_users.id` interno, username único, hash scrypt, status | Manter IDs, senhas e status; identidade Google referencia esse ID |
| Sessão | Token aleatório de 32 bytes; somente SHA-256 no Turso; 12h, revogação/status consultados por request | Reutilizar o mecanismo após OIDC; não usar ID/access token como sessão |
| Organização | `tenants`, com escopos compostos nas tabelas operacionais | Propor membership/roles do tenant sem tornar o Google dono de dados |
| Source/domínio | Source BYOK por tenant; domínio aponta para source | Autenticação não muda Resend, DNS, sources ou credenciais |
| Caixa | `mail_identities` representa mailbox/endereço, com ID próprio e domínio | Preservar caixas e permitir múltiplos grants por usuário |
| Permissões | Existência de `mail_identity_grants` concede leitura; `can_send` e `can_manage` adicionais | Leitura ainda é implícita; administração de domínio não existe como papel separado |
| Conteúdo | Metadados/threads/recipientes Turso; conteúdo, MIME e anexos privados R2 | Não migrar ou regravar conteúdo para trocar o login |
| Envio | Configuração BYOK por identidade, allowlist e limite móvel; jobs, hash de payload, idempotência e webhook | Preservar integralmente as restrições do piloto nesta PR |
| Processamento | Cron autenticado `/api/internal/mail-worker`, a cada 5 minutos; Receiving e Sending com flags independentes | Nenhuma alteração em worker/cron, deduplicação ou Notifications |
| APIs e UI | `/api/mail/[...segments]`, autenticação no servidor, grants em leitura/anexos/ações; compositor separado | Nova rota OIDC não concede nem modifica grants |

O usuário existente `mtcporto` tem ID interno UUID, está ativo e mantém grants de `contato`. `suporte` permanece desativada e sem envio/gerenciamento. O snapshot de `todoku` contém 9 registros de mensagem (incluindo históricos), 8 threads, 6 anexos, 17 objetos, 60 entradas de auditoria, 3 eventos inbound, 1 job outbound e 2 eventos de status. Todos foram apenas lidos; nenhum dado foi reinicializado.

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
| Administrar usuários e revogar sessões | Scripts operacionais; usuário desativado/sessão revogada negados | Membership/roles e APIs protegidas; suspensão revoga sessões |

A próxima migração deve acrescentar membership de organização, grants de administração de domínio e leitura explícita. A migração dos grants atuais deve preservar o acesso já concedido. Um administrador sem grant de leitura não poderá abrir mensagens/anexos. O mero vínculo OIDC jamais cria membership ou grant. Estes pontos são gates da fase 3, não capacidades já entregues pela PR.

## Segurança e rollback

O primeiro vínculo exige sessão atual do usuário interno configurado, state, cookie efêmero e conta Google com e-mail verificado autorizado. A sessão iniciadora é revalidada na transação depois da troca do código: expiração, revogação ou suspensão impedem o vínculo. O vínculo e a nova sessão são atômicos; a sessão iniciadora é revogada após sucesso. Login posterior exige o `subject` já vinculado; nunca faz fallback para busca por e-mail.

`openid-client` verifica Code + PKCE S256, state, nonce, issuer, audience/azp, expiração e assinatura RS256 via JWKS Google. Os endpoints são fixos e HTTPS, com timeout e redirects de rede recusados pela biblioteca. A resposta volta somente a `/mail` na origem configurada. O cookie temporário é HttpOnly, Secure e Lax para o retorno cross-site; a sessão final preserva HttpOnly, Secure, Strict e prefixo `__Host-`. Scopes apenas `openid email`; não há acesso ao Gmail nem refresh token.

Rollback: desativar `TODOKU_GOOGLE_OIDC_ENABLED` e publicar por GitHub → Vercel. O acesso por senha continua disponível, sem restaurar hashes ou IDs. Se necessário, revogar sessões pelo procedimento já existente antes da retomada. Deixar as tabelas aditivas e a auditoria preservadas; não executar down migration destrutiva nem remover bindings automaticamente. Senhas só devem ser desativadas numa entrega futura, após teste Google real e plano de recuperação aprovado.

## Limite da validação desta entrega

Há testes locais com JWTs RSA assinados e token/JWKS simulados, incluindo troca PKCE, assinatura inválida, claims, replay, concorrência, sessão revogada, CSRF e isolamento. A UI tem contrato automatizado desktop/mobile com APIs interceptadas. Esses testes não substituem um consentimento/login real no Google.

Os arquivos privados inspecionados ainda não contêm Client ID/Secret OAuth do Todoku; `.env.mail-access.local` contém apenas o acesso por senha. A autenticação do gcloud e a migração foram concluídas, mas criar o cliente Web requer a etapa documentada do Console. Configuração do cliente, primeiro vínculo e validação humana no Google permanecem pendentes. Nenhuma credencial OAuth foi criada e Google permanece explicitamente desativado em Production. Ver [procedimento de configuração e validação](MAIL-GOOGLE-OIDC.md).
