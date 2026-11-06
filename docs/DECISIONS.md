# Decisões — Todoku

> Registro de decisões de produto e arquitetura. Não é lista de tarefas nem autorização de execução. Atualizado em 06/11/2026. Decisões novas ou revogadas devem ser registradas em PR com data, motivação, consequências e links de evidência.

## D-001 — Separação dos produtos (05/11/2026)

**Decisão:** Todoku permanece um **Communication Hub** de eventos/notificações transacionais. **Todoku Mail** é um módulo de webmail, não o produto inteiro.

**Motivo:** evitar que a evolução do Mail desvie o escopo da API central e que a UI administrativa do Mail seja confundida com o painel do Hub.

**Consequências:** roadmaps e estados separados; compartilhamento de infraestrutura não implica compartilhamento de permissões ou autorização para ativar serviços.

## D-002 — SSO será projeto independente (05/11/2026)

**Decisão:** explorar futuramente um provedor de identidade/SSO independente, ainda sem nome. **Não construir agora.**

**Motivo:** separar autenticação central da lógica de comunicação.

**Consequências:** Todoku e demais aplicações mantêm identidades locais, dados e permissões de negócio. Login Google atual do Mail não equivale a SSO universal.

## D-003 — GitHub como fonte de verdade (05/11/2026)

**Decisão:** versionar estado e decisões em `README.md`, `AGENTS.md`, `docs/ROADMAP.md` e `docs/DECISIONS.md`.

**Consequências:** chat e issues fornecem contexto/evidência, mas agentes devem ler o repositório antes de implementar. Mudanças relevantes atualizam os documentos na mesma PR. Não apagar itens adiados para deixar a lista artificialmente concluída.

## D-004 — Prioridade do Mail MVP 3 (05–06/11/2026)

**Decisão:** implementar a entrega **7** antes das entregas **5 e 6**, sem renumerá-las. PR #27 documentou a prioridade; PR #29 implementou a entrega 7 e foi integrada em `a5a7ae6`.

**Consequências:** 5 (orçamentos/reservas) e 6 (consumo/quotas) continuam pendentes. A quota de **20 mensagens/24h** permanece. Não elevar limites sem orçamento agregado, contabilização e autorização.

## D-005 — Segurança e escopos do Mail (05–06/11/2026)

**Decisão:** `mail_users.id` é identidade interna; método de autenticação vem da sessão do servidor. Membership/role administrativa não concede leitura de mensagens. Acesso a conteúdo depende de grants explícitos `can_read`, `can_send` e `can_manage`.

**Consequências:** administrador não ganha inbox por conveniência; suspensão de membership é restrita à organização, enquanto sessões pessoais pertencem ao usuário. Nenhuma criação/ativação de domínios/caixas ou edição de roles deve ser presumida como entregue pelo painel MVP 3/4.

## D-006 — Publicação e operação controladas (decisão vigente)

**Decisão:** deploy automático após merge/push GitHub, com verificação na Vercel. Evitar `vercel --prod` redundante. Notifications permanece dry-run por padrão e marketing desabilitado; Mail mantém controles de envio, quotas, DNS e credenciais existentes até autorização específica.

**Consequências:** Preview com banco compartilhado é somente leitura para testes manuais; mutações de teste devem usar fixtures locais isoladas. Nenhuma alteração de infraestrutura ou política decorre apenas de documentação.

## D-007 — Concluir o Hub com a infraestrutura existente (06/11/2026)

**Decisão:** priorizar o MVP funcional do Communication Hub, reutilizando Resend,
Cloudflare, Vercel e Turso. MinhaNota/boas-vindas é o único fluxo piloto. Não
reconfigurar infraestrutura funcional nem reconstruir fila, worker ou BYOK.

**Consequências:** catálogo de templates comuns desabilitados por padrão,
versões específicas por aplicação e interface mínima em `/hub`. Autenticação
reutiliza sessões existentes, mas administração depende de grant próprio do Hub
por UUID/tenant, sem herdar papéis ou conteúdo do Mail. Novas aplicações começam
dry-run; envio real exige autorização específica. SSO, marketing, agendamento
avançado, painel sofisticado, outros provedores e onboarding universal ficam
adiados. Ver [diagnóstico e plano](HUB-MVP.md). Na preparação original, a
implementação estava em revisão; esta decisão, por si só, não autorizava merge
ou migração remota.

**Estado posterior (06/11):** PRs #31/#32 integradas. Mediante ponto de controle
e autorização explícita separados, 0009 aplicada e bootstrap restrito ao UUID
interno aprovado no tenant `todoku`, com auditoria. Painel/APIs conferidos por
senha; o responsável confirmou a organização na sessão Google existente.
Posteriormente, `todoku/minhanota` foi configurada em dry-run e a PR #3 do
consumidor publicada em `797886c`, sem envio real.
[Inicialização](HUB-INITIALIZATION.md) e [piloto](HUB-MINHANOTA-PILOT.md).

## D-008 — Provas distintas do piloto MinhaNota (06/11/2026)

**Decisão:** um evento controlado `user.welcome` pela API publicada pode validar
API → Todoku Hub sem depender de login e sem alterar históricos do consumidor.
Usar chave de idempotência exclusiva do teste, nunca a chave de boas-vindas por
destinatário do MinhaNota. Essa prova não valida o callback Google.

**Estado inicial:** configuração e deployments reconferidos; teste HTTP
bloqueado porque o token Sensitive existente não era recuperável nem tinha
cópia local. Nenhuma credencial foi criada sem autorização adicional.

**Estado posterior, autorizado em 06/11:** credencial temporária `events:write`
restrita a `todoku/minhanota`, com validade de 15 minutos e token somente em
memória. API → Hub **validado em Production** com evento
`201f7b21-e24a-4f79-8fd2-b3ba80686c98`: 202, replay idêntico, snapshot
`minhanota.welcome@1`, cron dry-run, status e auditorias. Credencial revogada
após o teste; GET e replay passaram a retornar 401. Token Production,
configuração, catálogo e históricos do consumidor permaneceram inalterados.
Naquela etapa, callback Google → MinhaNota → Hub permaneceu **pendente**,
independentemente dessa prova. Posteriormente foi validado separadamente na
D-009. [Evidências](HUB-MINHANOTA-PILOT.md).

**Consequências:** manter históricos, reservas e auditoria. Para callback, usar
login legítimo de outra conta Google verificada, com consentimento e elegibilidade
conferida, sem vínculos fiscais ou grants. Não fabricar callback, criar endpoint
de envio ou liberar Resend para contornar o bloqueio.

## D-009 — Repetição autorizada de boas-vindas da conta de teste (06/11/2026)

**Decisão posterior à D-008:** o responsável autorizou usar exclusivamente sua
conta Google e reinicializar apenas os registros de boas-vindas necessários ao
teste. A regra geral de idempotência permanece inalterada; não criar contas,
permissões ou dados fiscais para executar o piloto.

**Executado:** removida uma única linha de `emails_boas_vindas`, por e-mail
exato e instante original, em `2026-11-06T21:49:05.604Z`. Não havia reserva
`emails_boas_vindas_hub` da conta nem evento com a chave determinística do
consumidor no Hub. Demais boas-vindas preservadas; nenhuma tabela fiscal
alterada. Estado anterior e resultado guardados em relatório privado.

**Evidência posterior:** o titular concluiu o login Google real enquanto a
verificação prosseguia. Sessão do navegador `GOOGLE_OAUTH` confirmada para a
conta autorizada; reserva e aceite do consumidor às `21:49:57.924Z`,
evento `1e276d31-326b-4e50-886d-2c9c452a46e2` aceito com a credencial
Production do MinhaNota. Snapshot, template, cron dry-run e auditorias
conferidos. Logout e segundo login Google reais produziram nova sessão,
mantendo reserva/recibo/payload e somente um evento/outbox/tentativa.
**Google → MinhaNota → Todoku validado em Production dry-run**, sem sessão
fabricada ou chamada direta substituindo o callback.

**Envio real:** controles existentes permitem configuração de teste por
aplicação, destinatário único e orçamento de uma mensagem, com worker manual
por `configurationId`. Não há seletor de evento nesse endpoint; somente
`user.welcome` está habilitado no catálogo. A flag global de teste é exigida
pelo POST, mas não altera o cron dry-run. Nenhuma configuração real está
ativa. Callback dry-run agora comprovado; escopo exato de uma mensagem real
apresentado, mas sem confirmação adicional do titular indisponível. A
consulta a domínios Resend com chave legada retornou 401; transporte não
validado e nenhuma alteração realizada. Não habilitar flag, credencial
de transporte ou envio antes da confirmação e verificação. Um novo
evento de teste real terá chave própria; não converter o snapshot dry-run
nem apagar sua reserva para reutilizar a mesma chave determinística.

## D-010 — Primeiro envio real restrito do Hub para MinhaNota (06/11/2026)

**Autorização:** após as provas dry-run, o responsável autorizou uma única
mensagem real para sua conta, remetente `MinhaNota <notificacoes@minhanota.app>`,
template `minhanota.welcome@1`, novo evento pela API e processamento pelo
worker do Todoku, com conferência no provedor e Gmail.

**Preparação verificada:** domínio `minhanota.app` verificado com Sending
habilitado. Reutilizada a chave existente do MinhaNota com Sending access;
não confundir falta de permissão de consulta de domínios com domínio inválido.
Chave temporária de gerenciamento criada para verificar/configurar webhook
e reconciliar o teste, sem uso para enviar diretamente pelo Resend.

**Janela controlada:** configuração `test`
`583d6327-926d-4b87-8720-ec58f8dff855`, somente `todoku/minhanota`, allowlist
de um destinatário, limite atômico de uma mensagem. Somente `user.welcome`
habilitado. O POST do worker exige essa configuração explícita; o cron
continua dry-run. A flag de teste Production será liberada somente para
essa operação e restaurada em publicação automática GitHub/Vercel posterior.
Sem DNS, configuração fiscal ou mudança de runtime. Encerramento exige
revogação de credenciais temporárias e restauração da configuração dry-run.
**Resultado:** piloto concluído. Evento
`0fbd5888-fde4-4741-b594-0bdf03b1f5c4`, mensagem Resend
`01a1b2f1-a21e-7481-8ef5-23ffadff4fa1`, entregue na Caixa de entrada do Gmail
às 19h19 (UTC−03). Uma tentativa, orçamento consumido uma vez, replay sem
duplicação e segunda execução do worker sem trabalho. Webhooks assinados
`email.sent` e `email.delivered` processados.

Configuração original dry-run restaurada; configuração real revogada,
webhook dedicado desativado e credenciais temporárias revogadas. A publicação
de encerramento restaura `TODOKU_TEST_SEND_ENABLED=false` em Production.
Chave Sending existente e token do consumidor preservados. O callback Google
foi provado separadamente em dry-run; a mensagem real veio de novo evento
identificado da API, sem apagar reservas nem converter snapshots anteriores.
Ver [evidências](HUB-MINHANOTA-PILOT.md).

## D-011 — Biblioteca reutilizável e identidade por aplicação (06/11/2026)

**Decisão:** evoluir o catálogo e administração existentes, sem reconstruir o
transporte validado. Biblioteca global curada fornece modelos iniciais
opcionais; cópias residem nas tabelas existentes por tenant/aplicação.
Cadastro e adoção apresentam pacote selecionável e todas as associações
começam desabilitadas. Importação nunca troca um binding existente.

**Identidade:** nome, logotipo, cores principal/de fundo, site, suporte e assinatura são configuração
da aplicação, não do transporte. Layout reutilizável seguro separado do texto,
título, botão e rodapé. Novos snapshots congelam a renderização; templates
antigos sem apresentação mantêm o renderizador anterior. Publicar versão
não muda associações. @1 do MinhaNota não será sobrescrito: o modelo visual
recuperado do consumidor é publicado em versão nova com o mesmo `firstName`.

**Migração:** 0010 apenas adiciona colunas JSON anuláveis às tabelas Hub
existentes. Sem atualização automática de catálogos, migração em build/request
ou alterações no Mail. Enquanto não aplicada, administração ampliada falha
explicitamente e ingestão anterior permanece compatível.

**Estado de implementação:** renderização, catálogo e administração implementados;
167 testes, typecheck, build, consumidor real em fixture e interface
desktop/celular aprovados. CI e Preview aprovados. 0010 aplicada no banco único
em 06/11 após backup dos metadados; integridade/FKs, linhas existentes,
eventos, tentativas, credenciais e configurações de transporte preservados.
Publicação automática e seleção operacional da nova versão são registradas
separadamente na [PR #37](https://github.com/mtcporto/todoku/pull/37).
Não confundir implementação, Preview e Production.

**Limites:** eventos específicos de seis projetos são propostas documentadas
inativas. Sem emissores, campanhas, novos provedores, DNS, Google Workspace,
Client/Connect, migração de aplicações ou mensagens reais de teste.
Ver [templates](HUB-TEMPLATES.md) e [candidatos](HUB-EVENT-CANDIDATES.md).

## Histórico e referências

- [Roadmap consolidado](ROADMAP.md)
- [Plano detalhado Mail MVP 3](MAIL-MVP3-PLAN.md)
- [Perfil e navegação](MAIL-PROFILE-NAVIGATION.md)
- [Operação do Mail](MAIL-OUTBOUND.md)
- PRs #23–#29 e issue #28 no repositório.
