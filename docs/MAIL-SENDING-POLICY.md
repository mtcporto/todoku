# Política de envio após o piloto

Na fase 4 da [issue #20](https://github.com/mtcporto/todoku/issues/20), somente `contato@todoku.com.br` passa de allowlist Gmail/quota de uma mensagem para destinatários externos. Autenticação, grants, identidade/domínio/source ativos, origem das mutações e isolamento de tenant continuam obrigatórios. Google não concede acesso a uma caixa por si só.

## Configuração por tenant e identidade

A migração aditiva `0006_mail_sending_policy` acrescenta `recipient_policy` a `mail_sending_configurations`. O padrão é `allowlist`: aplicar a migração não libera destinos nem aumenta quotas existentes. BYOK, webhook, status e grants ficam intactos.

| Campo | Papel |
| --- | --- |
| `recipient_policy=allowlist` | Restrição opcional do piloto; todos os destinos Para/Cc/Cco devem estar na lista |
| `allowed_recipients_json` | Lista do piloto; vazia em modo `external` |
| `recipient_policy=external` | Aceita endereços válidos externos, sujeito às permissões e controles operacionais |
| `daily_limit` | Quota operacional móvel de 24h por identidade, compartilhada entre seus usuários; padrão 20, configurável de 1 a 100 |

A configuração de `contato` passa a `external`, lista vazia e `daily_limit=20`, substituindo a quota de 1. A conta Resend consultada em 05/11/2026 informa 100 e-mails/dia, 3.000/mês e 10 requisições/segundo, compartilhados pela conta. Envio, recebimento e outros produtos podem reduzir a disponibilidade. Os limites efetivos do Resend continuam soberanos; não são ampliados por essa configuração. [API oficial de uso](https://resend.com/docs/api-reference/usage/retrieve-usage).

Continuam: cinco pedidos de envio/minuto por usuário/tenant, dez destinatários combinados por mensagem, validação de anexos/tamanho, chave idempotente e snapshot de payload, lease/fencing, cinco tentativas com backoff e janela de retry inferior à do provedor. Respostas 429/5xx continuam tratadas pelo transporte existente. A quota conta jobs reservados na transação; retries do mesmo job não consomem outra mensagem. Uma rejeição não remove a reserva automaticamente.

A política é revalidada na fila e no worker, antes de construir o transporte. Reverter uma identidade para allowlist bloqueia jobs ainda não enviados para outros destinos. A quota da fila não é reaplicada ao retry de um job já reservado.

## Administração e operação

O serviço interno `updateSendingPolicy` valida e atualiza somente esses três campos, por tenant/identidade, na mesma transação da auditoria `sending_policy_changed`, incluindo antes/depois. É idempotente e não altera credenciais, status ou grants. O futuro painel do MVP 3 pode reutilizá-lo após autenticar e autorizar um administrador de domínio. Não há endpoint público novo nem permissão administrativa implícita por `can_send`/`can_manage`.

O CLI existente ganhou a operação `policy`. Exemplo PowerShell:

```powershell
$env:TODOKU_MAIL_SEND_RECIPIENT_POLICY = 'external'
$env:TODOKU_MAIL_SEND_RECIPIENTS = '[]'
$env:TODOKU_MAIL_SEND_DAILY_LIMIT = '20'
npm run mail:sending -- policy todoku <identity-id-contato>
```

As variáveis acima são entradas do CLI; a política de runtime fica no Turso. O comando não precisa receber, recriptografar ou rotacionar BYOK. `stage` continua preparando configurações pausadas e com allowlist; reexecutá-lo não libera destinatários implicitamente.

## Rollout e rollback

Fazer backup privado do banco único; validar a migração localmente e aplicá-la pelo runner existente. Publicar por PR/push/merge GitHub → Vercel. Após o deployment estar pronto, mudar apenas a política de `contato` pelo serviço/CLI e conferir auditoria e controles preservados. Não enviar mensagens externas de teste automaticamente.

Rollback imediato: selecionar `allowlist`, `['mtcporto@gmail.com']` e quota 1 pelo mesmo serviço/CLI. Em falha significativa, `mail:sending disable` bloqueia novas tentativas dessa identidade. Preservar jobs, recibos, credenciais e auditoria; não remover a coluna ou restaurar o banco em uso sem necessidade. Uma mensagem já aceita pelo provedor não pode ser desfeita. Receiving, Notifications e `suporte` permanecem intactos.
