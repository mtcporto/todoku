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
Callback Google → MinhaNota → Hub permanece **pendente**, independentemente
dessa prova. [Evidências](HUB-MINHANOTA-PILOT.md).

**Consequências:** manter históricos, reservas e auditoria. Para callback, usar
login legítimo de outra conta Google verificada, com consentimento e elegibilidade
conferida, sem vínculos fiscais ou grants. Não fabricar callback, criar endpoint
de envio ou liberar Resend para contornar o bloqueio.

## Histórico e referências

- [Roadmap consolidado](ROADMAP.md)
- [Plano detalhado Mail MVP 3](MAIL-MVP3-PLAN.md)
- [Perfil e navegação](MAIL-PROFILE-NAVIGATION.md)
- [Operação do Mail](MAIL-OUTBOUND.md)
- PRs #23–#29 e issue #28 no repositório.
