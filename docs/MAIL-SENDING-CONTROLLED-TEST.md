# Primeiro teste controlado de Sending

O responsável autorizou a fase C da [issue #15](https://github.com/mtcporto/todoku/issues/15), após a [validação completa do domínio e dos controles](https://github.com/mtcporto/todoku/issues/15#issuecomment-6660142006), em 05/11/2026.

## Escopo da ativação

- `TODOKU_MAIL_SENDING_ENABLED=true` exclusivamente em Production. Preview e Development continuam `false`.
- Somente `contato@todoku.com.br`, com o BYOK exclusivo de Sending já provisionado e criptografado.
- Webhook dedicado de status habilitado, sem alterar o webhook de Receiving.
- Allowlist exclusiva de `mtcporto@gmail.com` e limite de uma mensagem por janela móvel de 24 horas.
- Um envio sintético pela interface Todoku Mail; uma resposta pelo Gmail para verificar a conversa de volta no Todoku.
- DNS, credenciais, bancos, buckets e demais identidades preservados. Notifications e `suporte` continuam bloqueados.

Este commit publica o procedimento autorizado e permite que o deployment automático GitHub → Vercel incorpore a flag de Production. Não constitui evidência de que a mensagem já foi enviada. A configuração da identidade permanece pausada até o deployment estar pronto e os controles serem conferidos.

## Validação operacional

Antes do envio: conferir flags por ambiente, domínio verificado, configuração BYOK, webhook assinado, identidade/grants, allowlist, limite, inbox e bloqueio de Notifications. Nenhum envio por CLI ou diretamente ao provedor: compor e enviar pela interface.

Após o único envio: correlacionar o ID do job, chave idempotente, ID do provedor, eventos assinados `email.sent`/`email.delivered`, mensagem Gmail e pasta Enviados. Responder pelo Gmail e conferir `In-Reply-To`/`References`, mesma conversa, persistência Turso/R2 e inbox autenticada. Não repetir o envio para testar idempotência; conferir os registros e a unicidade existentes.

As evidências e o estado final da execução serão registrados na issue #15. O teste autorizado não inicia campanhas nem autoriza novas mensagens após esta execução.

## Contenção de falhas

Em falha significativa, desabilitar imediatamente a configuração de envio da identidade e o webhook dedicado, preservando Receiving e auditoria. Retornar a flag de Production a `false` e publicar a alteração pelo fluxo GitHub → Vercel, sem deploy manual redundante. Não reenviar uma mensagem de resultado incerto; investigar pelo ID do job, idempotência e eventos do provedor.
