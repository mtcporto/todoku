# Entrega, BYOK e teste controlado

O único banco continua sendo `todoku`. Por padrão, o cron `GET /api/internal/worker` roda a cada cinco minutos e processa até três mensagens transacionais em dry-run. Não chama o Resend. O endpoint exige `Authorization: Bearer <CRON_SECRET>`; esse segredo aleatório fica apenas no servidor. Preview pode ser testado manualmente com sua própria credencial de worker, mas nunca permite a operação POST de envio real.

## Configuração e segredos

Cada tenant/aplicação possui uma configuração ativa em `provider_configurations`. Não há fallback para uma chave global Resend. A chave de envio e o segredo de webhook são criptografados com AES-256-GCM, nonce aleatório e AAD contendo tenant, aplicação, configuração e finalidade. Trocar ciphertext entre escopos ou entre chave e webhook causa falha de autenticação.

- `TODOKU_MASTER_KEYS`: objeto JSON de IDs de chave para chaves aleatórias de 32 bytes em base64, somente no servidor.
- `TODOKU_ACTIVE_MASTER_KEY`: ID usado para novas gravações.
- `CRON_SECRET`: segredo de pelo menos 32 caracteres para invocar o worker.
- `TODOKU_TEST_SEND_ENABLED=false`: padrão; GET/cron continua dry-run mesmo se esse valor for liberado para o teste manual.

Os ambientes compartilham o banco e o keyring necessários para decifrar as mesmas configurações. Nenhum desses valores usa `NEXT_PUBLIC_`, aparece em respostas ou é escrito em logs. A API não tem endpoints públicos de provisionamento de chaves; a operação é feita pelo script de servidor autenticado ao banco.

`npm run db:provider -- dry-run <tenant> <application>` cria uma configuração de simulação sem chave Resend. Para um teste real, o operador precisa confirmar remetente, domínio e destinatário, registrar um webhook dedicado no Resend e fornecer ao processo de provisionamento:

- `RESEND_MANAGEMENT_KEY`, apenas durante a verificação do domínio pelo script, nunca persistida como chave de transporte;
- `RESEND_APPLICATION_KEY`, chave de envio confirmada para aquele escopo, preferencialmente restrita ao domínio;
- `RESEND_APPLICATION_WEBHOOK_SECRET`, segredo do endpoint dedicado;
- `TODOKU_SENDER_EMAIL`, `TODOKU_SENDER_NAME`, `TODOKU_RESEND_DOMAIN_ID`;
- `TODOKU_TEST_RECIPIENTS`, lista JSON de até três endereços explicitamente autorizados;
- `TODOKU_TEST_AUTHORIZED=true`.

Executar `npm run db:provider -- test <tenant> <application> [configuration-id]`. O script consulta o domínio no Resend, exige status verificado e correspondência exata com o remetente, e guarda somente os segredos criptografados. Não passar segredos por argumentos, commit, logs ou chat. O ID opcional permite registrar antecipadamente o webhook em `https://todoku.com.br/api/webhooks/resend/<configuration-id>`.

Nova configuração revoga a anterior para envio; mensagens antigas mantêm o snapshot e entram em revisão se a configuração foi revogada. Não mudam silenciosamente de chave ou remetente durante um retry. `db:provider revoke <tenant> <application> <id>` revoga envio; o segredo de webhook antigo permanece utilizável para rastrear mensagens em trânsito. Definir `TODOKU_REVOKE_WEBHOOK=true` revoga também sua recepção.

Para rotacionar a chave mestra, adicionar a nova chave ao keyring, mantê-la como ativa e executar `db:provider reencrypt <tenant> <application> <id>` em todas as configurações, inclusive revogadas com webhooks pendentes. Remover a chave antiga somente depois da recriptografia e da verificação. A operação mantém o conteúdo dos segredos, troca o envelope e registra auditoria.

## Worker, retries e garantias

O claim é transacional e reserva uma lease de 120 segundos com token de posse. A chamada ao provedor tem timeout de dez segundos e ocorre fora da transação. A finalização verifica o token; uma execução atrasada não pode sobrescrever o novo dono. Falha ao gravar o recibo deixa a lease recuperável e nunca é reportada como sucesso persistido.

O request, o remetente, o destinatário, o template e a chave de idempotência ficam congelados na ingestão. Respostas 429/5xx e falhas de rede usam backoff exponencial desde 30 segundos com jitter, limitado a uma hora e ao número máximo de tentativas. Erros permanentes encerram o trabalho quando não existe incerteza anterior; uma rejeição posterior não resolve um possível aceite anterior e, ao encerrar os retries, exige revisão manual. Conflito de idempotência do provedor, chave indisponível ou configuração revogada também exigem revisão.

O Resend retém chaves de idempotência por **24 horas**. O Todoku usa uma janela conservadora de **23 horas**, medida desde a primeira tentativa, para repetir um resultado ambíguo com a mesma chave e payload. Após essa janela, ou ao esgotar tentativas ambíguas, entra em `manual_review`; não tenta automaticamente outra chave. Leases expiradas não provam ausência de envio. **Não há promessa de exactly-once ponta a ponta.** [Idempotência do Resend](https://resend.com/docs/dashboard/emails/idempotency-keys).

O cron não envia testes reais. Retries de uma mensagem de teste exigem novamente a operação POST autenticada e a mesma configuração; o orçamento já reservado não é contado outra vez. Um resultado ambíguo deve ser reconciliado no provedor/webhook antes de qualquer intervenção manual que possa criar outra mensagem.

## Primeiro envio

Antes de enviar, apresentar remetente, destinatário, assunto e conteúdo e confirmar autorização. A configuração de teste tem allowlist exata, domínio verificado e orçamento inicial de **uma mensagem**. Mesmo com eventos distintos ou workers concorrentes, a reserva transacional impede ultrapassar esse orçamento.

Depois de configurar e autorizar o teste, liberar `TODOKU_TEST_SEND_ENABLED=true` no servidor e publicar pelo GitHub/Vercel. Invocar `POST /api/internal/worker` com a credencial de worker e JSON `{ "configurationId": "<id-confirmado>" }`. Consumidores só enviam eventos à API do Todoku; não conhecem Resend, chaves de transporte ou credencial do worker.

Templates iniciais: `user.welcome@1`, `system.validation@1`, `system.delivery_test@1`. O texto é validado por schema e escapado no HTML. Uma mensagem dry-run não será enviada depois de mudar o modo: sua fila fica terminal `cancelled`, com estado explícito `dry_run`. Criar um evento novo para o teste autorizado.

### Operação controlada da etapa 3

Em 04/11/2026, o responsável confirmou remetente, destinatário, assunto e texto de **um único e-mail**. O escopo dedicado `todoku-controlled-test/delivery-test` usou chave Resend restrita a domínio verificado, allowlist de um destinatário e orçamento de uma mensagem. O envio passou pela API publicada em `todoku.com.br`, com liberação temporária somente em Production, após o deployment automático do PR #8. Preview e cron permaneceram dry-run.

Evidência preservada no banco único `todoku`:

- Evento: `481218a6-9697-421b-9583-92202ca17937`.
- ID Resend: `01a1a8d7-346a-74bf-90c7-5d883da18ead`.
- Uma tentativa, uma reserva de orçamento e estado final `delivered`.
- Webhooks assinados `email.sent` e `email.delivered` persistidos e processados; entrega recebida pelo Todoku em `2026-11-04T23:14:01.623Z`.
- Consulta independente ao Resend confirmou `last_event=delivered`; o responsável também confirmou recebimento na caixa de entrada.

Após a entrega, a configuração e a credencial de ingestão do teste foram revogadas e a chave dedicada de envio foi excluída no Resend. O segredo de webhook permanece criptografado para rastrear eventual atualização dessa entrega. `TODOKU_TEST_SEND_ENABLED=false` foi restaurado em Production; este registro acompanha o deployment automático que aplica o bloqueio global. Nenhuma campanha foi iniciada. Novos testes exigem nova autorização e provisionamento explícito.

## Webhooks e estados

Cada configuração possui endpoint/segredo dedicado. A assinatura Svix é verificada sobre o corpo original, incluindo timestamp com tolerância da biblioteca de cinco minutos. Persistência e atualização do estado são transacionais; só então o endpoint responde 200. Falha de banco retorna 503, permitindo o retry do Resend. [Verificação oficial](https://resend.com/docs/webhooks/verify-webhooks-requests).

Eventos são deduplicados por escopo/provedor/ID Svix. O ID do e-mail é reconciliado somente com a configuração e escopo do endpoint autenticado. Webhooks que chegam antes do recibo são armazenados como `received` e reconciliados na finalização. Estados não retrocedem de entregue para enviado; reclamação e bounce prevalecem e criam supressão no mesmo tenant/aplicação. Metadata mínima é persistida; headers, segredos e conteúdo arbitrário do webhook não são armazenados.

`sent` indica aceite do Resend; `delivered` indica entrega ao servidor destinatário, sem prometer leitura ou inbox. `bounced`, `complained`, `suppressed` e `failed` são distintos. Assinaturas inválidas, timestamps antigos e eventos de outra configuração não alteram a entrega do aplicativo.
