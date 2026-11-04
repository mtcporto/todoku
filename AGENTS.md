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
