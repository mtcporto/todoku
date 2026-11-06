# Orientações aos agentes — Todoku

## Fonte de verdade e limites de produto

- Antes de planejar ou alterar código, ler `README.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md` e os documentos específicos da área afetada. Não tomar mensagens de chat ou uma issue isolada como estado mais recente que a `main`.
- **Todoku** é o Communication Hub de eventos e notificações; **Todoku Mail** é o módulo de webmail. O painel `/mail/admin` não conclui o painel administrativo do Hub.
- Um **SSO independente** é ideia futura, não escopo autorizado. Não implementar autenticação universal ou migrar identidades por inferência.
- Preservar ideias e entregas adiadas no roadmap. Atualizar roadmap e decisões na mesma PR quando houver mudança de estado, prioridade, arquitetura ou política; distinguir implementado, publicado, validado e planejado.
- Mail MVP 3: entregas 1–4 e 7 publicadas; 5–6 adiadas. Preservar limite de 20 mensagens/24h por identidade e demais controles. Não assumir que o painel atual cria/ativa caixas/domínios ou edita papéis.
- Papéis administrativos não dão acesso a conteúdo. Respeitar grants explícitos, escopo de tenant e método de sessão vindo do servidor.
- Auditar código e testes existentes antes de propor endpoints, migrações, dependências ou refatorações. Usar PRs pequenas, testes e evidências; não executar operações reais de produção sem autorização.

## Política de deploy — GitHub + Vercel

- Fazer commit e push na branch apropriada, aguardar o deployment automático GitHub/Vercel e verificar o resultado.
- Não executar `vercel --prod` nem publicar manualmente após o push. Investigar falhas antes de tentar outro deployment.
- Deploy manual somente por necessidade técnica específica e com justificativa explícita; evitar redeploy do mesmo commit sem motivo documentado.
- A regra não altera o uso de Turso, Cloudflare, R2 ou outros serviços.
- Manter o banco único `todoku`. Não habilitar recebimento nem alterar DNS/MX sem autorização explícita. Notifications permanece dry-run, marketing desabilitado e `TODOKU_TEST_SEND_ENABLED=false`.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
