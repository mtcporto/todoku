# Configurar e validar o Google OIDC

Primeira entrega da [issue #20](https://github.com/mtcporto/todoku/issues/20). O login atual é preservado. A [auditoria e proposta de migração](MAIL-MVP3-AUDIT.md) descrevem os limites desta PR.

## Pré-requisitos e variáveis privadas

É necessário um cliente OAuth **Web application** do Google para o Todoku. O usuário/senha de `.env.mail-access.local` não é esse cliente. Não copiar credenciais de outros produtos nem criar conta/cliente novo implicitamente.

No Google Auth Platform, selecionar o projeto autorizado e configurar o cliente Web. Para o piloto, limitar a audiência/test users a `mtcporto@gmail.com` quando aplicável. Scopes solicitados pelo Todoku: apenas `openid email`. Não habilitar APIs de Gmail nem autorização offline. [Documentação Google](https://developers.google.com/identity/openid-connect/openid-connect).

Registrar os dois callbacks autorizados para o cliente Todoku Mail:

- Preview da PR #21: `https://todoku-git-feat-mail-google-oidc-20-marco-portos-projects.vercel.app/api/mail/oidc/google/callback`.
- Production: `https://todoku.com.br/api/mail/oidc/google/callback`.

O cadastro do callback de Production foi autorizado; ativar Google nesse ambiente ainda depende da validação no Preview e de aprovação posterior. Não cadastrar localhost para este piloto.

Não usar callback wildcard. No Preview, selecionar alias estável e configurar `TODOKU_MAIL_ORIGIN` para esse alias; os URLs efêmeros de deployments não são callbacks automaticamente autorizados. Não autenticar no preview apontando o callback para Production.

Guardar Client ID e Secret em arquivo privado ignorado, como `.env.mail-oidc.local`, ou Secret Vercel no ambiente selecionado. Nunca imprimir valores, passá-los como argumentos ou enviá-los pelo chat. Variáveis de servidor:

| Variável | Valor/papel |
| --- | --- |
| `TODOKU_GOOGLE_OIDC_ENABLED` | `false` por padrão; `true` somente no ambiente em validação |
| `TODOKU_GOOGLE_CLIENT_ID` | Client ID do cliente Web autorizado |
| `TODOKU_GOOGLE_CLIENT_SECRET` | Secret do mesmo cliente; nunca `NEXT_PUBLIC_` |
| `TODOKU_GOOGLE_OWNER_USER_ID` | ID interno existente de `mail_users`, selecionado pelo operador |
| `TODOKU_GOOGLE_ALLOWED_EMAIL` | `mtcporto@gmail.com` no piloto; não vem do navegador |
| `TODOKU_MAIL_ORIGIN` | Origem exata do ambiente, sem barra final ou caminho |
| `TODOKU_MASTER_KEYS`, `TODOKU_ACTIVE_MASTER_KEY` | Keyring existente, sem gerar outro para o OIDC |

Conferir o usuário existente por consulta privada antes de selecionar o ID. Não substituir `mail_users.id` pelo e-mail ou Google subject. Não reutilizar um registro de variável compartilhado entre Production/Preview/Development ao ativar um único ambiente: conferir IDs/targets pela API e depois os valores de cada ambiente. `.env.example` não habilita a produção.

## Ordem de implantação

1. Revisar a PR e manter a flag Google desativada. Fazer backup/restore point do banco antes de qualquer migração operacional. A preparação de `0005` já foi executada conforme o registro abaixo.
2. Testar `0005_mail_oidc` numa base temporária local e conferir que usuários/grants existentes ficam iguais. A suíte automatizada já faz isso; não criar outro banco remoto para o piloto.
3. No banco único aprovado, aplicar a migração aditiva com o runner existente, selecionando explicitamente a URL privada do Todoku, sem imprimi-la. Preservar os checksums de `0001`–`0004`. Não executar migração em build/request.
4. Configurar o cliente e as variáveis apenas no ambiente de validação autorizado, com origem/callback correspondentes. Manter Receiving/Sending de Preview desabilitados. Antes de ativar Google em Production, concluir o vínculo e login reais num ambiente de validação e registrar o resultado.
5. Publicar por commit/push GitHub → Vercel e conferir CI/deployment automático. Não usar `vercel --prod` ou redeploy redundante. A flag continua off em Production durante esta PR.
6. Entrar pelo usuário/senha existente. Apenas a sessão do usuário interno selecionado oferece **Vincular Google**. Concluir pessoalmente a autenticação/consentimento e selecionar `mtcporto@gmail.com`.
7. Conferir **Google vinculado**, mesmo ID de usuário, mesmos grants e mesma inbox. Sair e usar **Entrar com Google**. Confirmar o novo acesso, sair novamente e testar o login por senha em uma sessão separada. Nenhum e-mail externo é necessário para validar login.

O endpoint `/api/mail/oidc/google/status` anuncia `enabled=false` quando a flag está desativada ou a migração está pendente; configuração inválida retorna erro sanitizado 503. A UI preserva o acesso por senha em ambos os casos. Início e vínculo usam POST com checagem de origem; callback usa GET com state e cookie de tentativa. Falhas retornam uma mensagem genérica e preservam o fallback. Não há cadastro público nem vínculo automático por e-mail.

## Preparação operacional em 05/11/2026

- `gcloud` autenticado com a conta responsável; quatro projetos existentes inventariados. `umbrella-mtcporto` é o candidato geral identificado, condicionado à conferência no Console de que o consentimento não pertence a outro produto. Nenhum projeto foi criado ou configuração de outro aplicativo alterada.
- A API/CLI de [OAuth para Workforce Identity Federation](https://docs.cloud.google.com/iam/docs/workforce-manage-oauth-app) não administra o cliente Google comum usado pelo Todoku. A antiga [API de clientes OAuth do IAP foi descontinuada](https://docs.cloud.google.com/iap/docs/deprecations/migrate-oauth-client). A criação do cliente Web deve usar [Google Auth Platform → Clients](https://support.google.com/cloud/answer/15549257?hl=en), sem endpoints improvisados.
- Backup privado com esquema até `0004`, integridade SQLite `ok` e zero violações de FK: `.vercel/backups/todoku-before-oidc-20261105.db`. SHA-256: `0315025f7c7b0614b1c2abeed04116b4350301957d48247660f0cdb1e4c575c7`. Leitura e dados do snapshot local conferidos; não foi realizado restore no banco em uso.
- `0005_mail_oidc` validada localmente, com reaplicação idempotente, e aplicada ao Turso existente às **18:12:26 UTC**. Comparação antes/depois confirmou os mesmos dados nas 30 tabelas anteriores, incluindo usuários, sessões, grants, mensagens e auditoria. Zero violações de FK após a migração.
- Vercel: flag Google explicitamente `false` em Production. Origem, usuário interno autorizado, e-mail e flag Google `false` configurados exclusivamente para o Preview da branch `feat/mail-google-oidc-20`, com registros separados de Production e Development. As flags de envio/recebimento e a origem de Production foram preservadas.
- Ainda pendentes: criar/baixar o cliente Web exclusivo com os dois callbacks; importar ID/Secret privados para o Preview da branch; habilitar Google apenas nesse Preview e publicar por push; concluir o vínculo e login reais com participação do responsável. O download pode ser salvo em `.vercel/google-oauth-todoku.private.json`, ignorado pelo Git.

O snapshot completo contém dados privados e fica somente no armazenamento local ignorado. Seu hash e os resultados de integridade podem ser registrados no GitHub; o banco, as credenciais e as sessões não.

## Evidências para promover o rollout

- Conta autorizada verificada, binding `(google, https://accounts.google.com, sub)` para o ID interno esperado, sem novos usuários/grants.
- Login posterior sem senha, cookie de sessão seguro, revogação e suspensão negando acesso.
- Outra conta Google recusada; nenhuma caixa concedida somente por autenticar.
- Desktop/mobile legíveis, fallback ainda funcional, Notifications e `suporte` bloqueados, limites de Sending preservados.
- CI/preview aprovados e login Google real registrado na issue #20, sem tokens ou códigos nos comentários/logs.

O ID token é validado por `openid-client`, com [verificação explícita da assinatura](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md). Não armazenar ID/access/refresh tokens. Tentativas expiram em dez minutos e são consumidas uma vez; cleanup de expiradas ocorre no próximo início de fluxo.

Para revogar um vínculo, impedir novos logins por seu status e revogar também as sessões do usuário: sessões existentes são do usuário interno, não do token Google. A futura administração deve fazer ambas as ações. Para interromper somente o provedor, manter a flag off e o fallback por senha; preservar auditoria e dados.
