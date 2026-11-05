# Histórico da preparação de Sending

Este documento preserva o snapshot anterior à aplicação do DNS. Os registros foram posteriormente aprovados, aplicados e verificados, conforme as evidências na issue #15. O procedimento autorizado para o primeiro envio está em [MAIL-SENDING-CONTROLLED-TEST.md](MAIL-SENDING-CONTROLLED-TEST.md).

Preparação da fase B da [issue #15](https://github.com/mtcporto/todoku/issues/15), autorizada no [registro do responsável](https://github.com/mtcporto/todoku/issues/15#issuecomment-6658856254). Estado conferido em **05/11/2026, 13:25 UTC**. A UX do compositor segue separada na #17.

## Estado executado

| Controle | Estado |
| --- | --- |
| Domínio Resend | `todoku.com.br`, região `sa-east-1` |
| Sending no provedor | `enabled`, apenas para obter os requisitos exatos |
| Estado agregado do domínio | `partially_verified`: faltam os registros de Sending abaixo |
| Receiving, DKIM e MX apex | habilitado / verificados; preservados |
| Credencial exclusiva | `Todoku Mail — Sending`, `sending_access`, restrita a este domínio |
| BYOK da identidade `contato` | criptografado e **disabled** |
| Webhook de status | dedicado e **disabled** |
| `TODOKU_MAIL_SENDING_ENABLED` | **false** em production, preview e development |
| Destinatário futuro permitido | somente `mtcporto@gmail.com` |
| Limite local preparado | **1 mensagem por janela móvel de 24 horas** |
| `suporte@todoku.com.br` | desativada; sem grant de envio |
| Notifications | permanece bloqueado |
| DNS modificado / mensagens enviadas | **zero / zero** |

A chave e o signing secret foram capturados diretamente para `.env.mail-sending.local` (ignorado pelo Git), sem imprimir valores, e gravados criptografados pelo mecanismo existente `mail:sending stage`. O round-trip AEAD confere com os valores privados. AAD de envio `tenant/todoku-mail-send/identity/finalidade` impede abrir o segredo no contexto de Receiving. A chave Full access de Receiving não foi reutilizada.

IDs operacionais, sem segredos:

- Domínio: `d59cb6bd-4f3b-421d-a432-151d5dd23c7f`.
- Chave de envio: `2cd3cdb3-7b1f-42f4-ac75-c354486cc46f`.
- Identidade: `439de6d6-d37b-49e9-8e47-36dcc2579599`.
- Webhook: `7717fd30-ba3c-48c9-af86-527b25bf8114`, endpoint `https://todoku.com.br/api/webhooks/mail/sending/439de6d6-d37b-49e9-8e47-36dcc2579599`.

Esse webhook assina somente `email.sent`, `email.delivered`, `email.failed`, `email.bounced` e `email.complained`. O webhook inbound existente continua habilitado e exclusivo de `email.received`; os outros endpoints da conta foram preservados.

## Diff DNS proposto — NÃO aplicado

Valores retornados pelo Resend após habilitar a capability Sending. Adicionar **somente estes três registros**, depois da aprovação explícita:

| Ação | Nome completo | Tipo | Valor exato | Prioridade | TTL / proxy |
| --- | --- | --- | --- | --- | --- |
| adicionar | `send.todoku.com.br` | MX | `feedback-smtp.sa-east-1.amazonses.com` | 10 | Auto / DNS only |
| adicionar | `send.todoku.com.br` | TXT | `v=spf1 include:amazonses.com ~all` | — | Auto / DNS only |
| adicionar | `rsend.todoku.com.br` | CNAME | `send.forge.rmta.net` | — | Auto / **não proxied** |

Não há registros atuais nesses nomes. Os seis registros existentes foram comparados antes/depois da preparação e permanecem idênticos: A apex e CNAME `www` do site, MX apex prioridade 0 `receive-sae1.forge.rmta.net`, DKIM `resend._domainkey`, SPF apex `v=spf1 -all` e DMARC `v=DMARC1; p=reject;`.

O SPF novo fica no subdomínio `send`; o plano não altera o SPF defensivo do apex, o MX de Receiving ou a política DMARC. Não substituir o CNAME por outro valor de exemplo nem ativar proxy Cloudflare. Antes de aplicar, consultar novamente o domínio para confirmar que os valores continuam iguais ao diff aprovado.

## Quotas e validação sem envio

A consulta autenticada da conta mostrou **1/100** mensagens diárias (zero enviadas, uma recebida), **14/3000** no ciclo mensal, **3/3** domínios e limite de API de **10 requests/segundo**. Receiving e outros projetos compartilham a quota da conta. Esses contadores são um snapshot e devem ser conferidos novamente antes do teste.

A conta já tinha três webhooks e aceitou a criação do quarto sem solicitar upgrade. Não houve mudança de plano, contratação ou criação de domínio/banco/bucket. O nome comercial do plano e faturamento não são retornados nessa consulta; não inferir cobrança ou franquia pelo número de endpoints. A [tabela pública de preços](https://resend.com/pricing) não substitui os limites efetivamente retornados pela conta.

Verificações executadas:

- A chave dedicada é reconhecida e não pode administrar recursos: `GET /api-keys` retorna `401 restricted_api_key`. Não foi usado `POST /emails` para testar a chave.
- BYOK e segredo do webhook decifram corretamente no escopo de envio; decifração no escopo de Receiving é recusada.
- Configuração de envio **disabled**, webhook de status **disabled**, allowlist exata e limite 1 conferidos no Turso.
- Em produção autenticada, pedido de envio retorna **403 `sending_disabled`**; endpoint de status retorna **503** enquanto pausado.
- Inbox real continua legível; Receiving ativo, uma mensagem existente, zero jobs de envio. Todas as flags de envio foram consultadas novamente na Vercel e estão `false`.
- DNS comparado por ID/conteúdo antes/depois, sem qualquer mutação.

Estas verificações validam a preparação e os bloqueios. Entrega ao Gmail, eventos de entrega e resposta na mesma thread ainda dependem do teste externo autorizado.

## Próximo gate e rollback

Ainda requer autorização do responsável:

1. Aplicar apenas o diff DNS acima e validar a propagação e os estados no Resend. Se os valores retornados mudarem, apresentar o novo diff antes de aplicar.
2. Após DNS verificado, habilitar exclusivamente a configuração de `contato`, o webhook dedicado e a flag de produção pelo fluxo GitHub → Vercel, mantendo preview/development pausados, `suporte` desativada e Notifications bloqueado.
3. Executar **um** envio sintético pela interface Todoku para `mtcporto@gmail.com`, conferir o Gmail, status em Enviados e resposta inbound na mesma thread. Não iniciar campanha ou envio adicional.

Rollback desta preparação: manter a configuração e o webhook outbound desativados e a flag global `false`; retornar somente Sending a `disabled` no domínio Resend, preservando Receiving. Não remover o webhook inbound nem revogar a chave Receiving. A chave dedicada pode ser revogada se a preparação for abandonada, preservando auditoria; não recriá-la sem necessidade. Nenhum rollback DNS é necessário agora, pois não houve alteração.

Se futuramente o diff aprovado for aplicado e precisar de reversão, remover apenas os três registros novos identificados pelos IDs criados; preservar os seis originais. Uma chamada de envio já aceita pelo provedor não pode ser desfeita: pausar configuração/webhook/flag impede novas tentativas após a próxima checagem, sem reenviar jobs ambíguos.
