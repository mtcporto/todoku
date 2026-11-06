# Mail — autorização por organização, domínio e caixa

Entrega 1 do plano da [issue #20](https://github.com/mtcporto/todoku/issues/20), publicada pela PR #23 em `85c17e7`. A migração aditiva `0007_mail_authorization` e os guards separam autenticação, administração e conteúdo. As APIs (#24) e os convites/sessões (#25) também estão publicados; o painel #26 permanece em revisão. [Estado atual e histórico do plano](MAIL-MVP3-PLAN.md).

## Modelo e permissões

`mail_users.id` continua sendo o ID interno imutável, compartilhado por senha e Google OIDC. `mail_memberships(tenant_id,user_id)` associa a conta à organização; suspendê-la bloqueia somente essa organização, inclusive em sessões abertas. Desativação global do usuário e revogação de sessão continuam bloqueando a autenticação correspondente.

`mail_admin_grants` registra papéis de organização, domínio ou caixa. FKs compostas impedem referências a recursos de outro tenant. `requireAdministration` exige usuário, tenant, membership e papel ativos, além do recurso solicitado. Organização abrange seus domínios/caixas; domínio abrange suas caixas; caixa abrange somente seus metadados. A administração de metadados pode alcançar recursos desativados, para permitir futura reativação explícita. Delegação e mutações administrativas serão implementadas na próxima PR, com guards dentro das transações.

Esses papéis nunca autorizam conteúdo nem criam grants. Ser administrador não concede inbox, corpos, threads, anexos, envio ou gerenciamento de mensagens.

| Capacidade | Permissão, além de usuário/tenant/membership/caixa/domínio/source ativos |
| --- | --- |
| Ler recebidas e enviadas da caixa | Grant explícito `can_read=1` |
| Compor e enviar | `can_send=1`, configuração/flag de Sending e política existentes |
| Abrir/editar/enviar rascunho novo | `can_send=1` e `author_user_id` igual ao usuário autenticado |
| Ler seus próprios envios sem leitura geral | `can_send=1` e autoria correspondente; sem mensagens recebidas da conversa |
| Gerenciar mensagens da caixa | `can_read=1` e `can_manage=1`, nunca uma role administrativa |
| Descartar/restaurar/excluir seu próprio rascunho | Autoria e `can_send=1`, sem gestão geral da caixa |
| Administrar metadados/permissões | Papel administrativo no escopo, sem conteúdo implícito |

Uma caixa compartilhada usa grants explícitos de vários usuários. Os rascunhos novos são pessoais mesmo nessa caixa. O tipo individual/compartilhada como metadado e sua administração visual ficam na entrega de caixas/painel.

## Guards e revogação

`authorization.ts` centraliza joins e visibilidade de lista, detalhe, thread, anexos e ações. Recursos inativos não retornam conteúdo. A inbox unificada exclui mensagens sem acesso; filtros não fazem fallback para outra caixa. Metadados de caixas concedidas, mas desativadas, podem continuar no seletor, sem autorizar mensagens.

Marcar leitura e ações de pasta revalidam acesso na transação. Rascunhos, reserva de envio e worker revalidam permissões antes do commit/transporte; detalhe, anexos e composição revalidam após I/O de storage. Uma revogação não depende de atualizar a interface ou refazer login. O recebimento automatizado mantém seus gates de tenant/source/domínio/caixa, sem depender de grants de usuário.

Não há transação distribuída entre revogação e requisição já entregue ao provedor. Revogar após o início do transporte não desfaz um envio; auditoria/idempotência permanecem. Upload de rascunho abortado pode deixar objetos staged, inacessíveis e sujeitos à limpeza existente.

## Migração e compatibilidade

- Preserva tabelas/IDs/linhas anteriores. Acrescenta memberships distintas a partir dos grants existentes, sem criar usuários/grants.
- `can_read` tem padrão **0 para grants novos**; backfill atribui **1 aos anteriores**, preservando leitura histórica. Caixa desativada permanece bloqueada.
- `author_user_id` usa o autor de `mail_send_jobs` nos envios existentes. Rascunhos antigos só recebem autor inferido quando existe exatamente um remetente possível. Rascunhos ambíguos ficam sem autor e conservam acesso legado por leitura+envio explícitos; grants sem leitura não os abrem. Rascunhos novos sempre têm autor.
- Cria papéis administrativos vazios e auditoria append-only. Nenhum login, e-mail ou binding Google concede papel.

O bootstrap é uma operação de operador confiável, fora de HTTP, com tenant e UUIDs existentes explícitos:

```powershell
$env:TODOKU_MAIL_ADMIN_BOOTSTRAP_CONFIRMED='true'
npm run mail:admin:bootstrap -- <tenant> <UUID-interno-existente> <UUID-do-ator>
```

Exige ator igual ao alvo e membership ativa. Atribuição inicial e auditoria são atômicas; repetir o bootstrap ativo não duplica registros. Recusa outro administrador organizacional existente ou atribuição revogada. Gestão posterior depende das APIs administrativas.

## Evidências de 05/11/2026

Backup privado exportado do banco único `todoku`, com checkpoint e SHA-256 `edb19128b82f9bd6e2df9a2f0370b4b611b8c85649b4f778eb037e056538d34a`. Cópia local validada com migração/reaplicação idempotente, integridade e FKs. Hashes de todos os campos anteriores nas **33 tabelas existentes**, local e remoto, confirmaram preservação de credenciais criptografadas, usuários, sessões, grants, mensagens, threads, anexos e auditorias.

Migração remota aplicada em `2026-11-05T20:43:38Z`, com 3 memberships equivalentes aos grants anteriores, integridade `ok` e zero violações de FK. Conforme autorização explícita, bootstrap do papel de organização `todoku` ao UUID existente `10a1ff09-52f6-4eee-9c78-ef670893d7ae`, com ator igual ao alvo. Auditoria `e59973a6-4d81-459d-aded-c7b6963add53`, ação `organization_admin_bootstrapped`. Sem seleção por e-mail/Google ou novo grant de conteúdo.

`contato@todoku.com.br` ativa, política externa, quota **20 mensagens/24h**. `suporte@todoku.com.br` desativada. Nenhuma alteração em DNS, credenciais, Receiving, Sending, Notifications, planos ou provisionamento. Nenhum envio externo nesta entrega.

Testes: isolamento de tenants/domínios, escopos administrativos, ausência de leitura implícita, caixa compartilhada, autoria/envio sem leitura, estados inativos em todas as APIs de conteúdo, revogação em sessões abertas/durante I/O, transporte bloqueado, bootstrap auditado/idempotente e backfill legado. Preservadas as regressões de senha/OIDC, envio/recebimento, quotas, idempotência e auditoria. UI valida `Sair` visível e acionável por teclado em desktop/celular.

Validação local: 111 testes aprovados, typecheck e build aprovados; contratos de UI do compositor e login/logout passaram em 1440×960 e 390×844, sem requisições externas. Após a migração, login por senha, inbox autenticada e logout na main passaram; Sending/Receiving e suporte desativada permaneceram como antes. Não foi repetido login Google real, nem envio externo. CI e Preview automático da PR registram a validação do código novo; a verificação da main nesta etapa confirma apenas compatibilidade com a migração aditiva.

## Publicação e rollback

A migração compatível precedeu o código. A PR #23 foi integrada em `85c17e7` e seu deployment automático chegou a READY, com o alias `todoku.com.br` e os fluxos de senha, sessão, conteúdo, anexos e logout validados. [Evidências da publicação e recuperação](https://github.com/mtcporto/todoku/issues/20#issuecomment-6669346903). Os guards compatíveis com `can_read` já estão na main. As [APIs administrativas #24](MAIL-ADMIN-API.md) foram publicadas em `37e20d4`; a referência anterior à revisão dessas APIs é histórica. Não aplicar permissões remotas durante os testes do painel #26.

Depois de introduzir grants sem leitura, **não voltar a versão que ignore `can_read`**. Em caso de falha, bloquear a funcionalidade afetada preservando guards/tabelas/auditorias. Sem down migration destrutiva ou restore sobre banco ativo como rotina; restaurar primeiro em ambiente isolado para recuperação planejada.
