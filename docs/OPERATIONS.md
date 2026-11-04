# Turso e publicação

Configuração inicial em 04/11/2026, na organização Turso `mtcporto`, grupo `default` (`aws-us-east-2`). O CLI está no WSL Ubuntu-24.04, em `/home/mtcporto/.local/bin/turso`, autenticado pela conta `mtcporto`. Verificar novamente autenticação e organização ao operar em outra sessão.

| Ambiente | Banco | URL |
| --- | --- | --- |
| Vercel Production (`todoku.com.br`), Preview, Development e desenvolvimento local | `todoku` | `libsql://todoku-mtcporto.aws-us-east-2.turso.io` |

O projeto está começando e usa um único banco, conforme decisão do responsável em 04/11/2026. O banco `todoku` foi criado vazio após inspeção das organizações acessíveis e recebeu a migração `0001_durable_ingestion`. Nenhum banco anterior de outro projeto foi reaproveitado ou modificado. O banco auxiliar `todoku-preview` foi descartado após verificar que continha somente testes sintéticos, tenants desativados, credenciais revogadas e mensagens canceladas, sem tentativas de envio. Novas migrações devem seguir o processo explícito de [API.md](API.md).

`TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` estão configurados no projeto Vercel `todoku`, equipe `marco-portos-projects`, sempre apontando para o mesmo banco. Os tokens têm escopo de banco, sem acesso ao grupo inteiro. Production e Preview usam variáveis Secret; as credenciais de cada ambiente podem ser substituídas sem criar outro banco. As cópias locais ficam somente nos arquivos ignorados `.env.local` e `.env.production.local`, ambos para `todoku`. Não imprimir nem versionar seus conteúdos. `vercel env pull` pode sobrescrever `.env.local`; preservar as configurações locais antes de usá-lo.

O projeto usa o ambiente Production da Vercel para a instalação de desenvolvimento/teste mencionada na issue #2. O envio de e-mails continua desativado: não há worker, cron ou adaptador Resend em execução. Ativar banco e ingestão não autoriza ativar entrega externa.

Após alterar variáveis, publicar o registro da alteração via commit/push e aguardar a integração GitHub/Vercel. As variáveis entram no próximo deployment; não executar publicação manual ou redeploy duplicado. Confirmar `/api/health`, a origem HTTP escolhida, o commit publicado e os testes de ingestão antes de encerrar uma ativação.
