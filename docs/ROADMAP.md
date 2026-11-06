# Roadmap — Todoku e Todoku Mail

> Fonte de verdade versionada para prioridades e pendências. Atualizado em 06/11/2026, após PR #32 (`2648f5e`) e preparação autorizada da 0009. Este documento descreve o estado **conhecido**, não substitui testes, auditorias operacionais ou evidência de produção. Alterações de escopo devem atualizar este arquivo na mesma PR.

## Produtos e fronteiras

- **Todoku (Communication Hub):** API central para eventos e comunicações transacionais de aplicações consumidoras, com templates, políticas, filas, provedores e auditoria; agendamento futuro solicitado pelo consumidor permanece planejado.
- **Todoku Mail:** módulo de webmail em `/mail`, com caixas, composição, recebimento, envio controlado, usuários e administração. Não substitui o Hub.
- **SSO independente (futuro):** projeto separado, ainda sem nome e sem implementação autorizada. Poderá autenticar produtos, mas não substitui os usuários, permissões ou dados de cada aplicação.

## Todoku — Communication Hub

| Frente | Situação conhecida | Próximo marco / condição |
| --- | --- | --- |
| Contratos de eventos, API e ingestão durável | Implementados; Turso, idempotência, worker autenticado e auditoria | Manter regressões e documentação de contratos |
| Templates versionados, políticas, BYOK, Resend e webhooks | Base implementada | Revisar lacunas por caso de uso antes de ampliar escopo |
| Notifications / entrega externa | **Dry-run por padrão**; marketing desabilitado | Ativação por tenant/aplicação somente com aprovação e validação operacional explícita |
| Filas, cron e reagendamento de tentativas | **Implementados** como infraestrutura de processamento/retry | Auditar execução e observabilidade com evidências; não presumir dashboard pronto |
| Agendamento futuro solicitado pela aplicação consumidora | **Planejado; não suportado pelo contrato atual de ingestão** | Definir campo/semântica da data futura, validação, políticas, persistência e testes antes de oferecer a capacidade |
| Preferências de destinatário, anti-fatigue e opt-out | Evolução planejada | Definir contrato e persistência antes da UI |
| MVP funcional do Hub | Backend #31 e painel #32 publicados; 0009, bootstrap e acesso administrativo validados por senha e sessão Google existente; piloto MinhaNota somente local em dry-run | [Evidências operacionais](HUB-INITIALIZATION.md); tenant `todoku` sem aplicações; próxima etapa é configurar MinhaNota em dry-run mediante autorização própria |
| Painel de administração do Hub | Interface mínima `/hub` publicada e validada por senha em desktop/celular; **não confundir** com `/mail/admin` | Configuração MinhaNota ainda pendente; dashboard sofisticado adiado |
| Adaptadores adicionais (SMS, WhatsApp, push, outros provedores) | Ideias futuras | Avaliar necessidade real, custos e compliance por canal |
| Integrações com apps consumidoras | Piloto escolhido: boas-vindas do MinhaNota | Reutilizar o fluxo existente, substituir Resend direto e validar ingestão → template → worker → status em dry-run |

Referências: [API](API.md), [Delivery](DELIVERY.md), [Operations](OPERATIONS.md). O diagrama por etapas no README é histórico, não prova de conclusão.


## Ideias registradas para depois do piloto — Todoku Client e Todoku Connect

> **Conceitos futuros, não autorizados para implementação nesta etapa.** Não interromper a validação do piloto MinhaNota → Hub nem alterar infraestrutura, DNS, credenciais ou provedores. Revisitar após comprovar a integração ponta a ponta e identificar repetição real na segunda aplicação (por exemplo, Selo).

### Todoku Client — o “garçom” das aplicações

**Problema:** mesmo centralizando o envio no Hub, cada aplicação ainda precisa repetir código de HTTP, autenticação, serialização, timeout, tratamento de erros e idempotência para emitir eventos.

**Proposta:** biblioteca/SDK pequeno e reutilizável, inicialmente Node.js/TypeScript, para enviar eventos de negócio ao Hub com contrato tipado, autenticação por aplicação, idempotência, erros e timeouts consistentes. A aplicação continua detectando o evento e produzindo seus dados; o Client apenas entrega o pedido; o Hub resolve templates, políticas, filas, entrega e auditoria. Não criar microsserviço intermediário, motor de workflows ou lógica de negócio específica no SDK. Extrair de integração existente e validar reutilização em uma segunda aplicação antes de expandir.

**Critério conceitual:** nova aplicação deve precisar somente instalar/configurar o Client e emitir eventos, sem integrar Resend diretamente nem reconstruir transporte.

### Todoku Connect — configuração guiada e provisionamento

**Problema:** ativar domínio/remetente exige registros DNS e autenticação de e-mail que são difíceis para usuários comuns; a experiência desejada é semelhante à integração Vercel ↔ Cloudflare, com autorização e configuração automática quando suportada.

**Proposta:** capacidade administrativa do próprio Hub para conectar aplicações, domínios e provedores; descobrir requisitos reais de envio/recebimento; apresentar alterações DNS propostas; solicitar autorização explícita e, por APIs oficiais/OAuth/permissões restritas, aplicar somente registros necessários, verificar propagação e status. Começar futuramente pela stack Cloudflare + Resend existente, sem presumir que MX, SPF, DKIM e DMARC sejam sempre iguais ou que registros existentes possam ser sobrescritos. Oferecer caminho manual quando automação não estiver disponível. Distinguir infraestrutura gerenciada pelo Todoku de credenciais/provedores do cliente (BYOK), com isolamento e auditoria.

**Fronteira:** integração com Vercel é conveniência para variáveis de ambiente/deploy, não requisito para enviar eventos HTTP. Não construir plataforma genérica de gerenciamento de cloud, DNS ou hospedagem. Outros provedores DNS/e-mail e outras stacks ficam para evolução posterior.

**Ordem de prioridade:** concluir piloto MinhaNota → Hub em dry-run; depois avaliar Client com segundo consumidor; somente então planejar Connect. Estas ideias não criam novas entregas no MVP atual.

## Todoku Mail

| Etapa | Situação em 06/11/2026 | Referência |
| --- | --- | --- |
| MVP 1 — caixa, leitura e Receiving | Implementado; piloto de Receiving já validado em produção | [Mail](MAIL.md) |
| MVP 2 — composição, respostas, rascunhos, enviados, lixeira e envio controlado | Implementado; Sending controlado de `contato` para destinatários externos conforme política vigente (20 mensagens/24h); não implica ativação de Notifications | [Outbound](MAIL-OUTBOUND.md), [política de envio](MAIL-SENDING-POLICY.md) |
| MVP 3 / 1 — autorização, grants e migração 0007 | **Publicado** (#23) | [Autorização](MAIL-AUTHORIZATION.md) |
| MVP 3 / 2 — APIs administrativas | **Publicado** (#24) | [API administrativa](MAIL-ADMIN-API.md) |
| MVP 3 / 3 — usuários, convites, sessões e migração 0008 | **Publicado** (#25); onboarding real de segundo convidado ainda não validado | [Usuários](MAIL-USERS-INVITATIONS.md) |
| MVP 3 / 4 — painel administrativo | **Publicado** (#26); catálogos de domínios/caixas e papéis parcialmente somente leitura | [Painel](MAIL-ADMIN-PANEL.md) |
| MVP 3 / 7 — perfil, sessões pessoais, login e navegação | **Publicado** (#29, `a5a7ae6`); validação funcional manual com sessão real ainda recomendada | [Perfil](MAIL-PROFILE-NAVIGATION.md) |
| MVP 3 / 5 — orçamentos e reservas de envio | **Adiado**, não implementado | [Plano detalhado](MAIL-MVP3-PLAN.md) |
| MVP 3 / 6 — painel de consumo e quotas | **Adiado**, depende de 5 | [Plano detalhado](MAIL-MVP3-PLAN.md) |

### Pendências que não devem desaparecer do planejamento

1. **Validação real controlada:** testar o perfil e navegação com sessão real; testar onboarding de um segundo usuário convidado, com consentimento e grants explícitos. Não executar testes mutáveis em preview com banco compartilhado.
2. **Administração completa de domínios/caixas e papéis:** cadastro/ativação e edição de roles **não foram entregues** pela #26; requer escopo e autorização próprios, sem ativação silenciosa de DNS, Receiving ou Sending.
3. **Entrega 5:** orçamentos agregados por provedor/tenant/domínio/caixa/usuário, reservas atômicas e idempotentes, contabilização por destinatário e reconciliação.
4. **Entrega 6:** visualização de consumo, quotas, reservas, alertas de UI e edição autorizada de limites, somente após a base contábil da entrega 5.
5. **Evoluções de UX do Mail:** priorizar problemas observados no uso real, sem redesign ou refatoração preventiva.

**Limite atual:** 20 mensagens por caixa/identidade em janela móvel de 24 horas; também permanecem os limites de requisições/destinatários e as regras do provedor. Não elevar para 50 nem interpretar subquotas como capacidade garantida do Resend sem implementar e revisar o orçamento agregado.

## Regras de execução

- Nenhuma linha de roadmap autoriza mutações de produção, mudanças de DNS, quotas, credenciais, grants, Resend, R2 ou flags.
- Para cada etapa: auditar código/documentos existentes → registrar escopo e critérios de aceite → PR pequena → testes/CI/Preview → revisão → merge autorizado → deploy automático GitHub/Vercel → verificação.
- Não executar `vercel --prod` depois de `git push` com deploy automático.
- Atualizar este roadmap e [DECISIONS.md](DECISIONS.md) na PR que muda estado ou decisão. Preservar ideias adiadas e referências históricas.
