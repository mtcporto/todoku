# Turso e publicação

Configuração inicial em 04/11/2026, na organização Turso `mtcporto`, grupo `default` (`aws-us-east-2`). O CLI está no WSL Ubuntu-24.04, em `/home/mtcporto/.local/bin/turso`, autenticado pela conta `mtcporto`. Verificar novamente autenticação e organização ao operar em outra sessão.

| Ambiente | Banco | URL |
| --- | --- | --- |
| Vercel Production (`todoku.com.br`) | `todoku` | `libsql://todoku-mtcporto.aws-us-east-2.turso.io` |
| Vercel Preview / Development e desenvolvimento local | `todoku-preview` | `libsql://todoku-preview-mtcporto.aws-us-east-2.turso.io` |

Ambos foram criados vazios após inspeção das organizações acessíveis. Nenhum banco anterior de outro projeto foi reaproveitado ou modificado. A migração `0001_durable_ingestion` foi aplicada e registrada em ambos. Novas migrações devem seguir o processo explícito de [API.md](API.md).

`TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` estão separados por ambiente no projeto Vercel `todoku`, equipe `marco-portos-projects`. Os tokens têm escopo de banco, sem acesso ao grupo inteiro. Production e Preview usam variáveis Secret. Development usa variáveis próprias para o banco de preview. As cópias locais ficam somente nos arquivos ignorados `.env.local` (preview) e `.env.production.local` (operação do banco publicado). Não imprimir nem versionar seus conteúdos. `vercel env pull` pode sobrescrever `.env.local`; preservar as configurações locais antes de usá-lo.

O projeto usa o ambiente Production da Vercel para a instalação de desenvolvimento/teste mencionada na issue #2. O envio de e-mails continua desativado: não há worker, cron ou adaptador Resend em execução. Ativar banco e ingestão não autoriza ativar entrega externa.

Após alterar variáveis, publicar o registro da alteração via commit/push e aguardar a integração GitHub/Vercel. As variáveis entram no próximo deployment; não executar publicação manual ou redeploy duplicado. Confirmar `/api/health`, a origem HTTP escolhida, o commit publicado e os testes de ingestão antes de encerrar uma ativação.
