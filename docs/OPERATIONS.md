# Turso e publicação

## Estado verificado em 06/11/2026

O Mail mantém Receiving e Sending operacionais, `contato` ativa, `suporte`
desativada e quota de 20 mensagens/24h. Inbox, mensagens, thread e anexo via R2
foram consultados em Production durante a inicialização do Hub. O estado
inicial de piloto pausado descrito em documentos antigos é histórico.
Notifications permanece dry-run por padrão e marketing desabilitado; essa
preparação não acionou worker nem enviou mensagens. Setup e acesso privado:
[MAIL.md](MAIL.md); evolução e reversão: [MAIL-ACTIVATION.md](MAIL-ACTIVATION.md).

O Hub publicado em `2648f5e` recebeu exclusivamente a migração 0009 e o bootstrap
autorizado para o UUID existente no tenant `todoku`. Painel e APIs validados com
sessão por senha; o responsável também confirmou a organização na sessão Google existente.
A aplicação `todoku/minhanota` foi configurada posteriormente em dry-run, com
`minhanota.welcome@1`; Production do consumidor está READY em `797886c`.
Reconferência atual: nenhuma tentativa/evento desse piloto, token Sensitive
sem acesso local; validação HTTP API → Hub bloqueada e callback Google pendente.
[Inicialização e recuperação](HUB-INITIALIZATION.md) e
[evidências do piloto](HUB-MINHANOTA-PILOT.md).

## Infraestrutura e histórico de preparação

Configuração inicial em 04/11/2026, na organização Turso `mtcporto`, grupo `default` (`aws-us-east-2`). O CLI está no WSL Ubuntu-24.04, em `/home/mtcporto/.local/bin/turso`, autenticado pela conta `mtcporto`. Verificar novamente autenticação e organização ao operar em outra sessão.

| Ambiente | Banco | URL |
| --- | --- | --- |
| Vercel Production (`todoku.com.br`), Preview, Development e desenvolvimento local | `todoku` | `libsql://todoku-mtcporto.aws-us-east-2.turso.io` |

O projeto está começando e usa um único banco, conforme decisão do responsável em 04/11/2026. O banco `todoku` foi criado vazio após inspeção das organizações acessíveis e recebeu a migração `0001_durable_ingestion`. Nenhum banco anterior de outro projeto foi reaproveitado ou modificado. O banco auxiliar `todoku-preview` foi descartado após verificar que continha somente testes sintéticos, tenants desativados, credenciais revogadas e mensagens canceladas, sem tentativas de envio. Novas migrações devem seguir o processo explícito de [API.md](API.md).

`TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` estão configurados no projeto Vercel `todoku`, equipe `marco-portos-projects`, sempre apontando para o mesmo banco. Os tokens têm escopo de banco, sem acesso ao grupo inteiro. Production e Preview usam variáveis Secret; as credenciais de cada ambiente podem ser substituídas sem criar outro banco. As cópias locais ficam somente nos arquivos ignorados `.env.local` e `.env.production.local`, ambos para `todoku`. Não imprimir nem versionar seus conteúdos. `vercel env pull` pode sobrescrever `.env.local`; preservar as configurações locais antes de usá-lo.

O projeto usa o ambiente Production da Vercel para a instalação de desenvolvimento/teste mencionada na issue #2. A etapa de entrega adiciona a migração `0002_delivery`, worker autenticado e cron a cada cinco minutos, em dry-run. Marketing fica desabilitado. BYOK e webhooks usam segredos criptografados e keyring de servidor. Envio real exige a configuração de teste, destinatário autorizado, orçamento e operação manual descritos em [DELIVERY.md](DELIVERY.md); não é habilitado pelo cron.

Após alterar variáveis, publicar o registro da alteração via commit/push e aguardar a integração GitHub/Vercel. As variáveis entram no próximo deployment; não executar publicação manual ou redeploy duplicado. Confirmar `/api/health`, a origem HTTP escolhida, o commit publicado e os testes de ingestão antes de encerrar uma ativação.
