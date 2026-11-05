# Mail MVP 2 — operação e ativação

A fase A da issue #15 implementa composição, respostas, encaminhamento, rascunhos, enviados e lixeira. **O envio externo permanece desativado.** A fase B exige autorização explícita antes de habilitar Sending, alterar DNS ou enviar qualquer mensagem. Notifications tem controles independentes e permanece bloqueado.

## Modelo e permissões

`0004_mail_outbound.sql` é aditiva. Mensagens existentes recebem `direction=inbound`, `delivery_status=received` e pasta `inbox`; conteúdo e IDs existentes são preservados. Há um banco Turso `todoku` e o bucket privado existente.

Grants `can_send` e `can_manage` começam em zero. A leitura não concede envio ou exclusão. Composição e envio exigem usuário, tenant, identidade, domínio e source ativos. Gerenciamento exige grant próprio. As rotas autenticadas verificam o escopo no servidor e as mutações verificam Origin. Downloads continuam privados.

O operador pode preparar somente um grant já existente:

```sh
npm run mail:sending -- grant <tenant> <identity-id> <username>
npm run mail:sending -- revoke <tenant> <identity-id> <username>
```

Isso não ativa uma identidade, Sending ou Notifications. No piloto, somente o proprietário de `contato@todoku.com.br` recebe as novas permissões; `suporte` continua desativada e sem envio/gerenciamento.

## Rascunhos, respostas e arquivos

Rascunhos usam JSON e anexos privados no R2, referências no Turso, UUID de criação idempotente e versão otimista na edição. A publicação é transacional após os uploads. Falhas deixam objetos em staging por até 24 horas para limpeza; uma falha de upload não substitui a versão publicada. Salvar é explícito; fechar com alterações pede confirmação. Nenhum conteúdo fica em localStorage.

Para/Cc/Cco são normalizados e deduplicados: no máximo 10 destinatários combinados. O usuário só seleciona remetentes autorizados. HTML passa pelo sanitizador existente; leitura continua em iframe isolado, sem imagens externas. O editor HTML aceita código; não é um editor visual rich text.

Respostas usam Reply-To ou remetente externo, excluem as identidades do próprio tenant e não copiam Cco. Responder a todos acrescenta Para/Cc visíveis. Encaminhamento cria nova conversa, sem cabeçalhos de resposta, e copia anexos autorizados. O contexto de resposta não pode mudar durante a edição do mesmo rascunho. `In-Reply-To` e `References` são derivados pelo servidor de mensagens acessíveis na mesma identidade. Mensagens inbound antigas têm fallback para o bloco de cabeçalhos do MIME privado, sem aproveitar Bcc.

Até cinco anexos, somando 2 MiB; requisição JSON até 4 MiB. TXT/CSV devem ser UTF-8 sem NUL; PDF/PNG/JPEG/ZIP/DOCX/XLSX têm extensão, MIME e assinatura inicial conferidos. Esses controles **não são antivírus**. Anexos existentes só podem vir do próprio rascunho ou da mensagem respondida/encaminhada na identidade autorizada.

## Envio e estados

Todos os seguintes controles precisam permitir envio:

- `TODOKU_MAIL_SENDING_ENABLED=true` no ambiente aprovado;
- identidade/domínio/source ativos e grant `can_send` vigente;
- configuração outbound habilitada, com BYOK separado e allowlist explícita;
- destinatários dentro dessa allowlist e limites disponíveis;
- domínio Sending verificado no Resend.

Sem a flag global, fila e webhook outbound recusam processamento, e o worker não consulta/descriptografa uma credencial de envio. Não existe fallback para a chave Full access de Receiving.

Enfileirar move o snapshot imutável para Enviados com estado **Na fila**. A chave idempotente é estável por mensagem, com job único. O worker usa claim transacional, lease de seis minutos e fence de conclusão; revalida grants e allowlist antes do transporte. Um job por execução, máximo cinco tentativas, backoff exponencial com jitter. Timeout, 5xx e lease perdido são conservadores quanto à aceitação. Após 23 horas da primeira tentativa não há reenvio automático, respeitando a [janela de 24 horas do Resend](https://resend.com/docs/dashboard/emails/idempotency-keys).

**Aceito pelo provedor** não significa **Entregue**. O webhook assinado dedicado `/api/webhooks/mail/sending/<identity-id>` trata `email.sent`, `email.delivered`, `email.failed`, `email.bounced`, `email.complained`, deduplica eventos e reconcilia eventos anteriores ao recibo. Registra o RFC Message-ID fornecido pelo Resend para thread de respostas inbound. Falhas ambíguas encerram em **Verificação necessária**; conferência manual no provedor precede qualquer resolução, sem criar outro job ou reenviar às cegas.

Limites locais: cinco pedidos de envio por minuto por usuário/tenant e 20 mensagens por identidade em janela móvel de 24 horas por padrão, configuráveis até 100. Há 20 escritas de rascunho e 30 ações de pasta por minuto, além de 50 rascunhos por identidade. Os limites do provedor também se aplicam.

## Lixeira e retenção

Excluir move apenas a referência da identidade para Lixeira; Restaurar volta à pasta anterior. Exclusão definitiva exige confirmação explícita e mensagem já na Lixeira. Mensagens com envio pendente ou ambíguo não podem ser excluídas até a resolução.

A referência é purgada após 30 dias na Lixeira, sujeita à retenção menor do source. Uma identidade não apaga conteúdo ainda referenciado por outra. Quando não restam referências vivas, acesso é revogado e metadados são redigidos; a remoção física do R2 é agendada, idempotente e repetida em caso de falha. Objetos substituídos por edição também expiram. Auditoria append-only é preservada. O cron existente executa limpeza; não há cron, banco ou bucket adicional.

## Fase B — plano para aprovação

O estado inicial da fase A tinha Sending desabilitado e apenas DKIM/MX Receiving disponíveis. A preparação autorizada da fase B habilitou a capability Sending **somente no provedor**, obteve os registros exatos e preparou chave exclusiva/BYOK e webhook, ambos pausados. A aplicação continua impossibilitada de enviar. Consulte o [estado validado, diff DNS pendente e rollback](MAIL-SENDING-PREPARATION.md) antes de qualquer ativação. A sequência abaixo descreve o plano geral; os itens de preparação já executados não devem ser repetidos.

1. Obter autorização para habilitar Sending somente no domínio piloto e consultar os registros exatos da conta/região. Se houver SPF/MX de Return-Path adicional, apresentar nomes/valores/prioridades exatos para aprovação antes de modificar DNS. Preservar MX apex de Receiving, DKIM, DMARC e registros do site; não copiar registros genéricos nem enfraquecer o SPF apex por suposição.
2. Preparar chave **Sending access**, restrita a `todoku.com.br`, mantendo a configuração desativada até DNS aprovado e verificado. Ela ainda pode enviar de qualquer endereço desse domínio no provedor; o Todoku limita o remetente pela identidade autorizada. Não reutilizar a chave Receiving Full access nem recriar a chave dedicada já preparada.
3. Criar webhook outbound dedicado nos cinco eventos listados, inicialmente pausado. Confirmar disponibilidade de endpoint no plano da conta; o [plano público Free permite um endpoint e 100 mensagens/dia](https://resend.com/pricing), portanto não presumir capacidade adicional. Não contratar upgrade automaticamente.
4. Ler `RESEND_MAIL_SENDING_KEY` e `RESEND_MAIL_SENDING_WEBHOOK_SECRET` de ambiente privado. `mail:sending stage` exige allowlist `TODOKU_MAIL_SEND_RECIPIENTS` e faz round-trip AEAD com AAD `tenant/todoku-mail-send/identity/finalidade`; fica **disabled**. Rejeita a chave já usada no source de Receiving. `TODOKU_RESEND_DOMAIN_ID` é necessário antes de habilitar.
5. Para o primeiro teste, allowlist somente `mtcporto@gmail.com` e `TODOKU_MAIL_SEND_DAILY_LIMIT=1`. Com autorização registrada, `mail:sending enable` exige `TODOKU_MAIL_SENDING_AUTHORIZED=true`, identidade ativa e domínio verificado/Sending habilitado, consultado por `RESEND_MANAGEMENT_KEY` privado; ativar webhook e flag apenas em produção aprovada.
6. Publicar configuração/código necessário por commit/push → GitHub/Vercel; aguardar deployment automático. Não executar deploy manual redundante. Não habilitar preview, `suporte` ou Notifications.
7. Pela UI, enviar uma única mensagem sintética com anexo autorizado ao Gmail, confirmar recebimento e Enviados, responder pelo Gmail e conferir thread inbound; registrar evidências sanitizadas e testar lixeira/restauração apenas com dados sintéticos.

Nenhum plano pago, novo banco/bucket ou envio é necessário para a fase A. O primeiro teste consome quota do Resend; armazenamento e leituras/escritas usam os serviços existentes. Confirmar o plano/quota disponível e eventual custo de endpoint adicional **antes** da ativação; valores dependem da conta. Não há contratação automática.

Rollback: desabilitar primeiro a configuração da identidade com `mail:sending disable`, pausar webhook outbound e Sending no Resend, definir flag global `false` e publicar pelo fluxo GitHub/Vercel quando necessário. A desativação no banco bloqueia novas tentativas imediatamente após a próxima checagem; uma requisição já aceita pelo provedor não pode ser desfeita. Preservar jobs, recibos, chave idempotente, auditoria e Receiving. Reverter código por commit Git se necessário; manter a migração aditiva.

## Verificação

```sh
npm run typecheck
npm test
npm run build
npm run mail:fixture
npm run dev:mail:fixture
# Em outro terminal, Chromium do Playwright instalado:
npm run smoke:mail:browser
npm run smoke:mail:outbound:browser
npm run mail:fixture:cleanup
```

Fixtures são locais, `.invalid`, com transporte simulado e credenciais próprias. O teste outbound de navegador valida desktop/mobile, persistência de rascunho/anexo/Cco, edição, resposta/encaminhamento, lixeira/restauração/purge confirmado, envio bloqueado e ausência de overflow/requisições externas de conteúdo. Testes de integração cobrem concorrência, recibos antes do commit, falhas de persistência e transporte, autenticação, CSRF, revogação, isolamento, idempotência e regressão inbound.
