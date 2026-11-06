# Eventos por projeto — propostas inativas

Inspeção de código em 06/11/2026. **Nenhum destes candidatos foi cadastrado,
ativado ou ganhou emissor.** Existência de tela, tabela ou handler não comprova
publicação, elegibilidade de destinatário ou autorização de comunicação.
O contrato abaixo é uma proposta, não uma mudança de API.

`recipient.email` identifica o destinatário fora de `data`. As variáveis listadas
ficam em `data`, com `actionUrl` HTTPS autenticado e textos limitados. Usar
referências opacas; não transportar XML fiscal, certificados, senhas, transcrições,
dados completos de leads ou detalhes pessoais sensíveis em mensagens.

## MinhaNota

Evidência: [README](https://github.com/mtcporto/minhanota/blob/main/README.md),
`src/lib/fiscal/nacional/servico-operacoes.ts` (autorização/reconciliação),
`cliente-sefin.ts` (resultado autorizada/rejeitada) e `transporte-sefin.ts`
(validade do certificado). Há operações e controles fiscais; isso não autoriza
realizar uma emissão para testar comunicação. Não foi localizado fluxo de
convite para empresa no código inspecionado.

| Evento candidato | Finalidade / condição | Variáveis necessárias | Destinatário esperado | Sugestão de template |
| --- | --- | --- | --- | --- |
| `fiscal.nfse_authorized` | Informar autorização persistida e confirmada, não apenas HTTP aceito | `firstName`, `documentReference`, `companyName`, `actionUrl` | Usuário fiscal autorizado para a empresa | `minhanota.nfse-authorized`, derivado de `general-notification` |
| `fiscal.nfse_rejected` | Avisar rejeição fiscal definitiva; não confundir com estado indeterminado | `firstName`, `operationReference`, `reasonSummary`, `actionUrl` | Responsável fiscal autorizado | `minhanota.nfse-rejected`, derivado de `action-required` |
| `company.invitation` | Convite para empresa; depende de implementar convites e elegibilidade | `firstName`, `inviterName`, `organizationName`, `actionUrl` | Convidado explícito, sem conceder papel pelo envio | Cópia de `invitation` |
| `certificate.expiring` | Avisar vencimento; leitura de validade existe, monitor/agendamento não comprovados | `firstName`, `companyName`, `expiresOn`, `actionUrl` | Responsável designado pela empresa | `minhanota.certificate-expiring`, derivado de `action-required` |

## Viva João Pessoa

Evidência: [README](https://github.com/mtcporto/vivajoaopessoa/blob/main/README.md),
`index.html` e `alertas/alertas.js`: notícias, shows e alertas meteorológicos
exibidos no site. O `localStorage` observado é cache, não cadastro de opt-in.
Não foi comprovado cadastro de assinantes, favoritos persistidos por usuário
ou gestão de alertas solicitados. Não transformar visitantes em destinatários.

| Evento candidato | Finalidade / condição | Variáveis necessárias | Destinatário esperado | Sugestão de template |
| --- | --- | --- | --- | --- |
| `bulletin.requested` | Boletim solicitado; requer preferências, consentimento e classificação de tráfego | `firstName`, `bulletinTitle`, `summary`, `actionUrl` | Assinante que solicitou o boletim | `vjp.bulletin`, derivado de `general-notification` |
| `favorite.event_updated` | Atualização de evento favoritado; favoritos ainda não comprovados | `firstName`, `eventName`, `changeSummary`, `actionUrl` | Usuário que favoritou e autorizou o alerta | `vjp.favorite-update`, derivado de `action-required` |
| `alert.requested` | Alerta de categoria/localidade solicitado, sem inferir inscrição pela visita | `firstName`, `alertTitle`, `summary`, `actionUrl` | Inscrito na categoria e localidade | `vjp.requested-alert`, derivado de `action-required` |

Boletins potencialmente promocionais ficam bloqueados pela política atual;
nome transacional não transforma campanha em comunicação transacional.

## Ride4x4

Checkout disponível: [mtcporto/ride](https://github.com/mtcporto/ride),
identificado como **Ride Experience** em `index.html`; site estático com roteiros
e reserva/contato por WhatsApp. Não foi confirmado que seja o projeto
Ride4x4 referido pelo responsável, nem backend de participantes/passeios.
Todos os candidatos dependem primeiro dessa identificação e do estado
persistente correspondente; link WhatsApp não comprova participação.

| Evento candidato | Finalidade / condição | Variáveis necessárias | Destinatário esperado | Sugestão de template |
| --- | --- | --- | --- | --- |
| `ride.participation_confirmed` | Confirmação persistida de participação, não interesse comercial | `firstName`, `rideName`, `startsAt`, `meetingPoint`, `actionUrl` | Participante confirmado | `ride.confirmation`, derivado de `general-notification` |
| `ride.updated` | Mudança relevante de horário/roteiro | `firstName`, `rideName`, `changeSummary`, `actionUrl` | Participante afetado | `ride.update`, derivado de `action-required` |
| `ride.notice` | Aviso operacional contextual | `firstName`, `rideName`, `message`, `actionUrl` | Participante do passeio correspondente | `ride.notice`, derivado de `general-notification` |

## Kindredveil

Evidência: [código](https://github.com/mtcporto/kindredveil/tree/main/src/app/api):
registro/login, personagens, chat e comentários/respostas
(`characters/[id]/comment/route.js`). Não foram encontrados serviço de convites,
caixa de notificações ou preferências de comunicação. Comentários são atividade
existente, mas não autorizam enviar a todos os participantes.

| Evento candidato | Finalidade / condição | Variáveis necessárias | Destinatário esperado | Sugestão de template |
| --- | --- | --- | --- | --- |
| `community.invitation` | Convite contextual; mecanismo e autorização ainda não comprovados | `firstName`, `inviterName`, `organizationName`, `actionUrl` | Pessoa expressamente convidada | Cópia de `invitation` |
| `community.notification` | Notificação selecionada pelo usuário; preferências ainda necessárias | `firstName`, `message`, `actionUrl` | Usuário elegível e inscrito na categoria | `kindredveil.notification`, derivado de `action-required` |
| `community.activity` | Atividade relevante, por exemplo resposta em comentário | `firstName`, `activitySummary`, `actionUrl` | Autor/seguidor com preferência explícita | `kindredveil.activity`, derivado de `general-notification` |

Não incluir conteúdo de chat, personagens privados ou inferências pessoais
na mensagem; usar descrição mínima e link para sessão autorizada.

## Todoku

Evidência existente neste repositório: `src/lib/configurations.ts` verifica
domínio, `src/lib/worker.ts` persiste falhas e aplica `send_limit`,
administração/auditorias registram mudanças. Esses estados existem;
emitir notificações a partir deles ainda exige regra, destinatário e
idempotência próprios. Não criar recursão de notificações de falha.

| Evento candidato | Finalidade / condição | Variáveis necessárias | Destinatário esperado | Sugestão de template |
| --- | --- | --- | --- | --- |
| `domain.verified` | Informar confirmação persistida de domínio, sem alterar DNS | `firstName`, `domain`, `applicationName`, `actionUrl` | Administrador explícito da aplicação/tenant | `todoku.domain-verified`, derivado de `general-notification` |
| `delivery.failed` | Avisar falha terminal, não cada retry | `firstName`, `deliveryReference`, `errorSummary`, `actionUrl` | Responsável operacional autorizado | `todoku.delivery-failed`, derivado de `action-required` |
| `sending.limit_reached` | Avisar limite atingido sem elevar quota | `firstName`, `applicationName`, `limitSummary`, `actionUrl` | Responsável pela aplicação | `todoku.sending-limit`, derivado de `action-required` |
| `credential.revoked` | Avisar revogação auditada, sem divulgar token ou segredo | `firstName`, `applicationName`, `credentialReference`, `actionUrl` | Responsável autorizado | `todoku.credential-revoked`, derivado de `security-alert` |

## Imobiliária Pé na Areia

Evidência: [README](https://github.com/mtcporto/imobiliariapenaareia/blob/main/README.md),
`db/turso-schema.sql` (`olx_leads`, distribuição e newsletter),
`src/app/api/webhooks/olx/route.ts` e busca pública de imóveis. Leads e catálogo
de imóveis existem. Matching com preferências, agendamento de visitas,
workflow de propostas e assinaturas de disponibilidade **não foram comprovados**
nos contratos/schema inspecionados. Newsletter não autoriza estes fluxos.

| Evento candidato | Finalidade / condição | Variáveis necessárias | Destinatário esperado | Sugestão de template |
| --- | --- | --- | --- | --- |
| `lead.created` | Notificar lead persistido/atribuído, sem copiar seus dados pessoais | `firstName`, `leadReference`, `propertyReference`, `actionUrl` | Corretor/responsável atribuído | `pna.lead-created`, derivado de `action-required` |
| `property.matched` | Imóvel compatível com busca salva; matching/consentimento ainda necessários | `firstName`, `propertyTitle`, `matchSummary`, `actionUrl` | Interessado que solicitou correspondências | `pna.property-match`, derivado de `general-notification` |
| `visit.scheduled` | Visita efetivamente agendada; fluxo ainda não comprovado | `firstName`, `propertyTitle`, `scheduledAt`, `actionUrl` | Participantes confirmados, individualmente | `pna.visit-scheduled`, derivado de `general-notification` |
| `proposal.received` | Proposta persistida; workflow e permissões ainda necessários | `firstName`, `proposalReference`, `propertyReference`, `actionUrl` | Responsável autorizado pela proposta | `pna.proposal-received`, derivado de `action-required` |
| `property.availability_updated` | Mudança persistida relevante; falta comprovar assinatura/histórico | `firstName`, `propertyTitle`, `availabilitySummary`, `actionUrl` | Interessado explicitamente inscrito | `pna.availability`, derivado de `general-notification` |

Não configurar domínio, Resend, DNS, Google Workspace ou integrações nesta
etapa. Correspondências e atualizações com caráter promocional não podem
contornar `marketing=disabled`.

## Condições para futura operação

Para cada candidato: confirmar projeto/funcionalidade publicada; evento
persistente e transação de origem; destinatário e escopo; consentimento e
classificação de tráfego; variáveis mínimas; link autorizado; idempotência;
versão e binding **inativo**; testes locais. Só depois de aprovação específica
implementar emissor, ativação ou envio. O catálogo não detecta acontecimentos,
agenda monitoramento ou concede permissões às aplicações.
