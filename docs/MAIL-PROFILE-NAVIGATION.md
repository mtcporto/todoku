# Todoku Mail — perfil, sessões e navegação (entrega 7)

Issue #28, antecipada às entregas 5–6 pela decisão da PR #27, já integrada à main em `6168ad0`. Base inicial da implementação: main `76270a0`, após publicação da #26; branch sincronizada com `6168ad0` para revisão da PR #29. A PR #29 foi integrada por squash na main em `a5a7ae6` e publicada automaticamente em produção (READY). Validação manual funcional com sessão real ainda recomendada. Todoku continua sendo o Communication Hub; este trabalho pertence ao módulo Mail, não ao futuro SSO.

## Auditoria antes da implementação

| Necessidade | Estado encontrado / decisão |
| --- | --- |
| Identidade interna e método atual | GET `/api/mail/session` já retorna usuário, capacidades e `session.method`; falta apresentação pessoal |
| Vínculo Google | GET `/api/mail/oidc/google/status` informa disponibilidade/vínculo; mostrar esse estado sem inferir o método da sessão nem expor claims ou tokens |
| Sessões pessoais | GET `/api/mail/sessions` e POST `/api/mail/sessions/:id/revoke` já têm paginação, autorização do próprio usuário e auditoria transacional; criar UI, sem nova API |
| Logout | POST `/api/mail/logout` e botão Sair já existem; preservar e integrar ao perfil |
| Administração | `/mail/admin` e `canAdminister` publicados; acrescentar navegação pessoal sem conceder capacidades |
| Organização/domínio/caixa | Inbox já lista somente grants autorizados, inclusive metadados de caixas inativas, mas não retorna tenant nem filtra mensagens por tenant. Complemento mínimo: `tenant_id`, `domain_status` e filtro `tenant` no GET existente, mantendo todos os joins/guards |
| Estados e acessibilidade | Melhorar hierarquia do login, contexto selecionado, ausência de leitura/caixa inativa, carregamento, sessão revogada, teclado e foco; preservar compositor e identidade visual |

Não há lacuna que exija endpoint novo, tabela ou migração. A lista de organizações do Mail deriva exclusivamente das caixas concedidas; não reutiliza os catálogos administrativos como autorização de conteúdo.

## Limites de validação

Escritas somente em fixtures locais isoladas. O Preview compartilha o banco operacional; testes automatizados interceptam todas as APIs Mail antes de usar handlers reais com o banco local. Inspeção manual remota apenas de leitura. Não validar Google real, criar convites ou conceder permissões nesta entrega.

Preservar quota20/24h, rate limits, DNS, Resend, credenciais, Sending, Receiving, Notifications e dados existentes. Não implementar orçamentos/consumo (entregas5–6), alterar OAuth, provisionar caixas/domínios ou criar cadastro público. Publicação somente GitHub → Vercel após merge autorizado.

## Interface e contratos

- `/mail/profile`: estrutura pública sem dados pessoais antes da autenticação; carrega sessão, sessões pessoais e status Google em paralelo. 401 limpa o contexto e retorna ao login com aviso. Falha ao consultar Google preserva o restante do perfil; indisponibilidade do provedor não significa ausência de binding.
- O menu **Perfil**, disponível no Mail, administração e perfil, oferece navegação e **Sair**, com teclado, Escape, foco e fechamento ao sair do menu. `canAdminister` controla somente a navegação; APIs continuam autorizando todas as operações.
- O método vem de `session.method`: senha, Google OIDC ou método não registrado para sessões legadas. Vínculo Google é exibido separadamente, sem expor subject, claims, credenciais ou tokens. O username e UUID identificam o usuário interno; uma identidade de envio não é sua conta de login.
- A lista pessoal usa páginas de25 e indica método, datas, sessão atual, expiração e revogação. Revogar exige confirmação do alvo/datas e usa somente o ID público da sessão. Cancelar não escreve; um latch bloqueia duplo clique. Revogar a atual encerra o acesso neste navegador; outras sessões são preservadas. Sessões são globais ao próprio usuário, não permissões de uma organização; a confirmação explica esse alcance.
- GET `/api/mail/inbox` aceita `tenant` opcional (até100 caracteres, parâmetro único), combinado por AND com domínio/caixa e os guards existentes. Contexto desconhecido ou sem grant não concede acesso. A lista `identities` permanece o catálogo autorizado, independente dos filtros, agora com `tenant_id` e `domain_status`; nunca é um diretório administrativo. Cursor é limpo ao trocar contexto. Respostas antigas abortadas não restauram a seleção anterior.
- Caixas inativas continuam visíveis como metadados, identificadas e sem conteúdo; falta de leitura mostra aviso separado de envio próprio. Revogação/erro limpa mensagens anteriores. O contexto mostra organização, domínio e caixa selecionados, com filtros e sem acesso adicional. A composição nova respeita o contexto no remetente inicial e preserva o compositor existente.

## Verificação

`npm test` inclui isolamento do filtro de organização, combinação com domínio/caixa, input inválido, suspensão e caixa inativa. A suíte existente preserva sessões, guards, concorrência, autoria, envio, recebimento, idempotência e auditoria.

`npm run smoke:mail:profile` renderiza a UI local ou do Preview em desktop1440×960 e mobile390×844. Intercepta **todas** as APIs Mail, executando handlers reais contra fixtures locais isoladas. Cobre sessão senha com Google vinculado, método Google/legacy, catálogo/paginação pessoal, recusa de revogar terceiro, cancelamento/foco, duplo clique/auditoria, revogação atual, falha503/recuperação, falta de sessão/grants, navegação administrativa e contexto entre organizações. Nenhum request de escrita chega ao servidor remoto. Screenshots/evidências ignorados pelo Git em `.vercel/profile-ui/`.

CI executa testes, typecheck, build e cinco suítes Playwright: compositor, OIDC, convites, painel e perfil. O planejamento da PR #27 já está na main e foi incorporado à branch da implementação; a PR #29 foi integrada e publicada; não repetir merge ou deploy manual. Entregas5–6 adiadas, quota20/24h preservada.

Validação local:152 testes aprovados, typecheck/build aprovados e cinco suítes desktop/mobile aprovadas. Inspeção visual de Mail/perfil e login preservou a identidade visual; menu limitado à viewport e estados de conteúdo indisponível distintos de caixa vazia. CI e Preview foram validados e registrados nas issues #28/#20; produção READY após o merge, sem teste de escrita remota nesta documentação.
