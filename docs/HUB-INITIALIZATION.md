# Hub — inicialização operacional de 06/11/2026

## Escopo e publicação

PRs #30, #31 e #32 integradas. A release de Production em
`https://todoku.com.br/hub` é `2648f5e95a147c96f23ca23ad688af76b3892163`,
deployment `dpl_GfR9mW7JdhUCpFMYiPC8chGG6aAe`, READY. A preparação abaixo
operou o banco existente; não exigiu mudança de código nem outro deployment.

A causa da preparação pendente foi confirmada no banco e no contrato de
`/api/hub/session`: 0009 ausente, nenhuma tabela `hub_*` e resposta
`hub_setup_required` após autenticação. Autenticação do Mail e autorização
administrativa do Hub continuam independentes.

## Ponto de controle e backup

Banco selecionado: Turso `todoku`, ID
`01a1a8a8-2d01-763f-8e11-70348c786901`, grupo `default`, `aws-us-east-2`.
A URL coincidiu com a documentação, CLI autenticado e cópia privada de
Production. Os valores Sensitive atuais da Vercel não puderam ser relidos;
a conexão usou a credencial privada existente, sem substituí-la.

Antes de qualquer escrita remota:

- `integrity_check = ok`, zero violações em `foreign_key_check`.
- Migrações 0001–0008 conferidas por checksum; somente 0009 pendente.
- Exportação pelo Turso CLI, restauração local e ensaio isolado de migração e
  bootstrap aprovados. As 38 tabelas anteriores preservaram esquema e dados.
- Revalidação imediatamente antes da aplicação: nenhum digest mudou desde o
  backup. O responsável autorizou explicitamente a 0009 e o bootstrap para o
  tenant `todoku`, com usuário e ator iguais ao UUID interno aprovado.

Backup privado em `.vercel/hub-preflight-20261106T150444Z/`, ignorado pelo Git,
com ACL restrita à conta Windows executora. **Os dois arquivos são necessários,
preservados juntos com estes nomes; o DB sozinho não representa o backup.**

| Arquivo | Bytes | SHA-256 |
| --- | --- | --- |
| `todoku-before-0009.db` | 786432 | `0f04200d5d192a4c8f520d16806082b08d0266e461c797c3db7995e446bab179` |
| `todoku-before-0009.db-wal` | 824032 | `86125b8c9d06c4a823ac2bc8c1f4e45747d7ffdcca21d0b3106d7b0465c28afa` |

Não publicar os arquivos, credenciais ou conteúdo dos relatórios privados.

## Migração e autorização

O runner existente aplicou exclusivamente `0009_hub_operations`, registrada em
`2026-11-06T15:22:04.138Z`, checksum
`b47404ee5a19e7e9f89946b2454087c3bb3558cf09ee414698b2176ebf9e056a`.
Nenhuma migração anterior foi reaplicada.

A conexão caiu durante a leitura posterior ao commit. Antes de qualquer nova
ação, outra consulta confirmou a migração e a preservação das tabelas antigas;
o runner não foi repetido. As cinco tabelas novas estavam vazias, integridade
ok e FKs sem violações.

Após essa validação, `scripts/bootstrap-hub-administrator.ts` foi executado uma
vez para o usuário/ator explicitamente aprovado, no tenant `todoku`, com a
confirmação somente no ambiente desse processo. Resultado: uma autorização
ativa e um registro `administrator.bootstrapped`, auditoria
`5bf6b5cb-611f-4be6-84ee-cbacacaa9174`, em `2026-11-06T15:22:35.485Z`.
Nenhum privilégio foi inferido do e-mail, domínio ou papel no Mail.

## Evidências e limites da validação

- Login por senha em sessão de teste isolada na API publicada do Hub: 200,
  mesmo usuário interno e `auth_method=password` no Mail. A mesma sessão foi
  reconhecida pelos dois módulos.
- `/api/hub/session`: 200, somente o tenant autorizado `todoku`.
- Catálogo `/api/hub/tenants/todoku/applications`: 200, **lista vazia**. Não
  foram criadas aplicações, adotados catálogos ou configurado o MinhaNota.
- Anônimo: 401; consulta autenticada fora do tenant: 403. A negação a outro
  usuário autenticado sem papel próprio foi coberta com fixtures locais,
  sem criar usuários nem sessões de terceiros em Production.
- Navegador isolado contra Production, sem mock de APIs: painel visível em
  1280×900 e 390×844, organização selecionada, catálogo carregado, mensagem de
  preparação ausente, APIs 200, sem erro JavaScript nem overflow horizontal.
  Mutações foram bloqueadas no navegador de validação; nenhuma foi solicitada.
- Mail: inbox, duas mensagens, thread e download de um anexo via storage
  operacional aprovados. Sending e Receiving continuam ativos para a
  configuração existente; `contato` ativa e `suporte` desativada.
- Logout da sessão de teste: 200; Hub e Mail recusaram sua reutilização com
  401. Não foi efetuado logout das sessões previamente existentes.
- Conferência final: integridade ok, zero violações de FK; entre as tabelas
  antigas, somente sessões e contadores de login mudaram durante os testes.
  Usuários (3), memberships (3), grants de conteúdo (6), mensagens (24),
  anexos (14), objetos (56), credenciais e demais configurações preservados
  por digest. Permanecem uma sessão ativa Google e uma por senha do proprietário.
  A política de envio continua `external`, habilitada e com limite de 20/24h.
- `/api/health`: ready, ingestão durable, entrega padrão dry-run e marketing
  disabled. Não foi acionado worker nem enviado e-mail.
- 159 testes automatizados locais, typecheck e build aprovados; os testes
  utilizam bancos isolados. Não houve alteração de código ou migração.

**Sessão Google existente:** após a solicitação de conferência usando essa
sessão, o responsável confirmou manualmente: “organização todoku aparece”.
Essa evidência humana complementa os testes automatizados por senha; o acesso
automatizado ao navegador local retornou `Computer Use native pipe is unavailable`.
A comparação com o backup confirmou que as duas sessões anteriores permanecem
inalteradas. Não houve novo consentimento automatizado nem alteração de OAuth.

Relatórios, contagens, digests e screenshots de validação estão somente no
diretório privado do ponto de controle. O acesso administrativo foi validado
com senha e sessão Google existente; a configuração e o piloto MinhaNota
continuam pendentes.

## Recuperação e próxima operação

Não reaplicar 0009 nem repetir bootstrap para resolver erro de conexão. Primeiro
consultar histórico, autorização e auditoria. O bootstrap pode acrescentar nova
auditoria mesmo quando a autorização já existe.

Em falha de acesso, investigar cookie, sessão, status do usuário/tenant e grant
explícito do Hub. Não alterar autenticação nem herdar papéis do Mail. Preservar
auditoria e dados operacionais; uma revogação do Hub deve limitar-se ao grant
correspondente e exigir autorização própria.

Para recuperação por backup, copiar **DB e WAL** para diretório isolado e
verificar os hashes antes de abrir a cópia. Rodar integridade, FKs e conferir
histórico/contagens antes de planejar restauração remota. Não sobrescrever o
banco operacional com atividade posterior do Mail; isso requer procedimento
e aprovação próprios. Não voltar a código que ignore `can_read`.

Nenhum envio real, worker global, DNS, Resend, Cloudflare, credencial, quota ou
caixa foi alterado. O próximo passo é uma autorização separada para configurar
MinhaNota inicialmente em dry-run; o catálogo vazio não é defeito de login.
