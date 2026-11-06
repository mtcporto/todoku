# MVP 3 — plano administrativo, quotas e usabilidade

## Estado atual das entregas

| Entrega | PR / commit integrado | Estado |
| --- | --- | --- |
| 1. [Autorização e migração 0007](MAIL-AUTHORIZATION.md) | #23 / `85c17e7` | Publicada |
| 2. [APIs administrativas](MAIL-ADMIN-API.md) | #24 / `37e20d4` | Publicada |
| 3. [Usuários, convites e sessões / 0008](MAIL-USERS-INVITATIONS.md) | #25 / `1b6cd00` | Publicada; login Google do proprietário validado; onboarding real de convidado pendente |
| 4. [Painel administrativo do módulo Mail](MAIL-ADMIN-PANEL.md) | #26 / `76270a0` | Publicada; painel administrativo em produção |
| 5–6. Orçamentos, consumo e quotas | — | **Adiadas por decisão de produto**; executar após entrega 7; manter 20 mensagens/24h |
| 7. [Perfil, login e navegação](MAIL-PROFILE-NAVIGATION.md) | #29 / `1c19c96` | **Implementada, em revisão, sem merge**; entregas 5–6 adiadas |

A #26 reutiliza integralmente as APIs e migrações publicadas. Oferece catálogos, grants, convites sem envio automático e suspensão/reativação de memberships. Edição de papéis e criação/ativação de domínios/caixas não integram esta PR. Escritas de teste usam fixtures locais isoladas, inclusive ao renderizar o Preview conectado ao banco operacional. Não repetir 0007/0008.

## Priorização vigente (05/11/2026)

Por decisão de produto, **executar a entrega 7 antes das entregas 5 e 6**, mantendo a numeração original. A entrega 7 cobre perfil, método real de login da sessão, gestão de sessões pessoais, navegação Mail/Admin, contexto de organização/domínio/caixa e usabilidade. A implementação está em revisão na PR #29, com reutilização das APIs existentes e sem migrações. A revisão e os testes precedem qualquer merge.

As entregas 5 (orçamento/reservas) e 6 (painel de consumo/quotas) permanecem pendentes, sem mudança de limites: **20 mensagens/24h**, sem ampliação de envio, DNS, Resend ou flags. Não presumir que a entrega 7 inclui cadastro/ativação de domínios/caixas ou edição de papéis, itens não entregues pela #26.

## Histórico — proposta original após PRs #21/#22

O restante deste documento preserva a auditoria e o plano originais, incluindo lacunas e escopo proposto à época; não descreve o estado atual. A tabela acima e os documentos de cada entrega registram sua evolução. A quota permanece 20 mensagens/24h até orçamento agregado e contabilização por destinatário.

Proposta após auditoria somente de leitura em 05/11/2026. Base: `main` em `1fec48a`, migrações `0001`–`0006`, PRs #21/#22 concluídas. Esta proposta não aplica migrações, altera quotas ou concede papéis. Evidências e lacunas: [auditoria](MAIL-MVP3-AUDIT.md).

## Decisões de modelo

- Organização é o tenant existente; um tenant pode ter vários domínios, e cada domínio várias caixas. Preservar todos os IDs e relacionamentos.
- Google/senha autenticam `mail_users.id`. O e-mail Google é atributo verificado, não chave primária, organização ou identidade de envio.
- Membership associa usuário à organização. Papéis administrativos têm escopo de organização, domínio ou caixa, sem conceder acesso ao conteúdo.
- Grants de conteúdo permanecem em `mail_identity_grants`: `can_read`, `can_send`, `can_manage`. Este último continua significando gerenciamento de mensagens, não administração de usuários/caixa.
- A proposta permite envio sem leitura geral: `can_send` autoriza compor/enviar conteúdo próprio, não abrir inbox, anexos recebidos ou rascunhos de outros. Isso exige autoria explícita de rascunho/guard próprio, hoje ausentes. Gerenciamento de mensagens exige leitura; administração de metadados da caixa continua sendo uma role separada sem leitura automática.
- Caixa individual/compartilhada é metadado da mailbox; seus participantes usam grants explícitos. Ser proprietário ou administrador não cria grants automaticamente.
- O administrador inicial proposto é o usuário interno já vinculado a `mtcporto@gmail.com`, no tenant `todoku`. Bootstrap explícito, único e auditado pelo UUID, sem inferir privilégio de todo login Google. Não criar esse papel silenciosamente nesta auditoria.
- Administração de organização pode gerir seus domínios e membros; administração de domínio não pode alterar a organização ou outro domínio; administração de caixa fica restrita àquela caixa. Delegações não podem conceder escopo superior ao do ator.
- Suspender membership corta acesso somente naquela organização. Suspensão global da conta não deve ser operação irrestrita de um administrador de tenant. Revogação global de sessões pertence ao próprio usuário ou operador global autorizado; a gestão administrativa deve revogar o acesso no seu escopo sem derrubar outra organização.
- Preservar senha, binding Google, usuários e grants atuais. `contato` permanece ativa, `suporte` desativada; nenhuma outra caixa/domínio é ativada pelo rollout.
- A lista de organizações/domínios administráveis vem das memberships/roles, separada da lista de caixas legíveis. Hoje os domínios da UI derivam dos grants de caixa; esse caminho não pode ser reutilizado como autorização administrativa.

## PRs propostas

Cada PR terá testes, documentação e rollout próprios; não reúne toda a administração numa refatoração do Mail.

| PR | Escopo | Aceite principal |
| --- | --- | --- |
| 1. Autorização e migração aditiva | Propor `0007`: memberships/papéis por escopo e `can_read` explícito; serviços de autorização usados em todas as rotas de conteúdo/ações | Backfill dos grants legados preserva sua leitura atual; grants novos começam sem leitura. Admin sem grant não lê inbox, detalhe, thread ou anexo. Estados inativos bloqueiam acesso de forma consistente. Nenhuma role administrativa é concedida pelo login |
| 2. APIs administrativas básicas | Listagem e gestão de memberships, papéis e grants por organização/domínio/caixa; sessão informa capacidades administrativas | Guard no servidor, Origin, validação, auditoria de ator/alvo e escopo; negar delegação superior/cross-tenant. Bootstrap auditado do proprietário explicitamente no rollout. Nenhum endpoint de administração lê conteúdo de mensagens |
| 3. Usuários, convites e sessões | Criar/convidar usuário interno, associação controlada, suspensão/revogação; registrar método de autenticação na sessão, preservando as existentes | Convites com token somente em hash, validade e consumo único, vinculados ao alvo. Reutilizar protocolo OIDC e binding seguro; nada de cadastro/vínculo automático por e-mail. Sessões antigas indicam método não registrado. Inicialmente, link de convite pelo painel; envio externo de convite exige ação/autorização específica |
| 4. Painel administrativo e caixas | Telas pequenas de usuários/papéis/grants e cadastros de domínios/caixas; tipo individual/compartilhada, ativação/desativação controlada | Admin autorizado opera sem SQL/CLI; nenhum acesso de leitura implícito; caixa compartilhada funciona para dois usuários. Cadastros novos começam pausados e não disparam DNS, Resend ou criação de credenciais. Ativações explícitas com precondições verificadas |
| 5. Orçamentos e reservas de envio | Camadas provedor/organização/domínio opcional/caixa/usuário; ledger de destinatários faturáveis; reutilizar `updateSendingPolicy` | Reserva atômica e idempotente, concorrência entre caixas/usuários, retries sem dupla cobrança e reconciliação de incerteza. Manter 5 pedidos/min e 10 destinatários. Elevação de contato para 50 somente como alteração auditada desta entrega, sujeita ao orçamento agregado |
| 6. Painel de consumo e quotas | Consumo diário/mensal, mensagens versus unidades de destinatário, reservas, disponibilidade estimada, reset/frescor e edição de limites | Usar APIs autorizadas; avisos propostos em 80/90/100%, apenas na UI, sem habilitar Notifications. Quotas de caixas não aparecem somadas como garantia do provedor; escopo de visualização não expõe dados de outro tenant |
| 7. Perfil, login e navegação | Sair em texto, menu de perfil/sessões, hierarquia do login Google/senha, contexto organização/domínio/caixa e acesso ao admin | Reaproveitar a identidade visual e os seletores existentes. Método da sessão vem do servidor, não da existência de binding. Responsividade, teclado, foco/fechamento de menus e mensagens claras para ausência de acesso, desativação e quota |

Caso a gestão de caixas da PR 4 fique grande, separar a listagem/formulários de usuários dos formulários de caixa/domínio, sem misturar com quotas ou redesign. A numeração real das migrações será definida em cada PR após conferir a main.

## Quotas em camadas

| Camada | Unidade e janela | Função |
| --- | --- | --- |
| Conta Resend | Destinatários enviados + recebimentos; dia UTC e ciclo mensal informado pela API | Limite real compartilhado entre chaves/domínios/produtos; identificador lógico da conta, não uma quota independente por API key |
| Organização/tenant | Orçamento agregado de unidades faturáveis por período, com reservas pendentes | Compartilhar capacidade entre caixas e reservar margem para recebimento/outros consumidores; orçamento configurado não é capacidade garantida |
| Domínio, opcional | Suborçamento de unidades dentro da organização | Controlar consumo por domínio sem multiplicar a capacidade do tenant/provedor |
| Caixa/identidade | Mensagens/jobs em janela móvel de 24h; cada job informa também seu total de destinatários | Preservar `daily_limit`/`updateSendingPolicy`; a quota da caixa é teto, não reserva de capacidade do provedor |
| Usuário | Pedidos por minuto e limites de destinatários/tamanho por mensagem | Proteção contra abuso; não representa consumo faturável do provedor |

Consumo consultado: 3/100 diário (1 enviada + 2 recebidas), 16/3.000 mensal (14 enviadas + 2 recebidas), 10 requisições/segundo e 3/3 domínios. O Resend informa reset diário em `2026-11-05T23:59:59.999Z` e mensal em `2026-11-20T22:30:38.859Z`. Mostrar datas na UI com timezone explícito, sem converter janelas diferentes em uma única ideia de "hoje".

Há margem no snapshot para estudar 50 mensagens, mas 50 × 10 destinatários representam até 500 unidades enviadas. A quota de 20 permanece vigente. Não aplicar 50 isoladamente antes do orçamento agregado. Manter as regras do provedor: [quotas e contagem de destinatários](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [consumo e limites da conta](https://resend.com/docs/api-reference/usage/retrieve-usage).

Reservas precisam persistir número de destinatários normalizados/deduplicados, conta do provedor, tenant, domínio, caixa, job e período. O schema atual conta jobs e não possui esse ledger. Reservar atomicamente nas camadas aplicáveis, contabilizar uma vez por job e revalidar permissões/política antes do transporte. Não liberar reserva ambígua, nem presumir que bounce ou erro implica estorno. Reconciliar os totais com o provedor sem contar novamente um envio já refletido no snapshot.

Consumo externo ao Todoku e inbound podem ocorrer entre consultas. Portanto, snapshots com margem e reservas locais reduzem risco, mas não garantem o saldo global; o provedor continua a autoridade final. Estado desatualizado/indisponível deve ser visível e ter comportamento conservador. Não prometer orçamento de inbound garantido: o Todoku toma conhecimento depois do recebimento no provedor.

## Rollout, preservação e testes

1. Antes de cada migração: backup privado do banco único, leitura/integridade/FKs, cópia local de validação e registro do hash. Conferir checksums e reaplicação idempotente; não editar migrações aplicadas.
2. Comparar IDs, usuários, bindings, grants, configurações criptografadas e conteúdo antes/depois. Backfill somente do acesso já existente; não recriar usuários, mover mensagens/anexos ou recriptografar BYOK por conveniência.
3. Instalar a migração de compatibilidade antes de publicar os novos guards. Não criar grants que dependem de `can_read=0` enquanto o servidor antigo ainda interpreta existência de grant como leitura. Habilitar mutações administrativas somente com o novo servidor pronto.
4. Publicar cada PR pelo fluxo commit/push/merge GitHub → Vercel, um deployment por alteração necessária. Nenhum `vercel --prod` redundante; diagnosticar falha antes de nova tentativa.
5. Regressões: tenants/organizações distintos; domínio A versus B; administrador sem leitura; mailbox compartilhada com grants diferentes; revogação/suspensão; usuário sem role acessando API admin diretamente; sessões senha/Google; conteúdo/anexos/threads; envio e recebimento; quotas concorrentes e contagem Para/Cc/Cco; retries, idempotência e auditoria.
6. UI: desktop/mobile, navegação por teclado, foco, Sair explícito, manutenção de rascunhos e feedback de acesso/quota. Sem troca de identidade visual.
7. Rollback por desativação dos novos recursos administrativos e bloqueio das operações afetadas, mantendo os guards de conteúdo. Não voltar a um servidor antigo que ignore `can_read` após criar grants sem leitura. Preservar tabelas/auditoria; nada de down migration destrutiva ou restore do banco em uso como rotina.

Nenhum novo domínio, credencial, bucket, banco, plano pago, campanha ou envio externo faz parte desta auditoria/plano. Implementação e atribuições administrativas serão mudanças explícitas das PRs, preservando o estado inicial aprovado.
