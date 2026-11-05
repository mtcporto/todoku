# Todoku Mail — painel administrativo (MVP 3, entrega 4)

Base: main `1b6cd00`, após PRs #23/#24/#25 publicadas. Todoku é o **Communication Hub**; este painel administra o módulo **Todoku Mail**. O futuro SSO permanece independente e fora do escopo.

## Cobertura auditada antes da implementação

O escopo aprovado está integralmente coberto pelas APIs atuais. **Nenhum endpoint, autorização adicional ou migração é necessário.**

| Necessidade                            | API existente                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------- |
| Entrada administrativa                 | GET `/api/mail/session`, capacidades por UUID/membership/papel                  |
| Organizações e domínios administráveis | GET `/api/mail/admin/organizations` e `…/:tenant/domains`                       |
| Caixas e estados                       | GET `…/:tenant/mailboxes`                                                       |
| Usuários, memberships e papéis         | GET `…/:tenant/memberships` e `…/:tenant/roles`                                 |
| Grants de conteúdo                     | GET `…/:tenant/grants`; PUT/DELETE `…/:tenant/mailboxes/:identity/grants/:user` |
| Criar, listar e revogar convites       | POST/GET `…/:tenant/invitations`; POST `…/:tenant/invitations/:id/revoke`       |
| Suspender/reativar membership          | PUT `…/:tenant/memberships/:user`                                               |

Contratos e delegação: [APIs administrativas](MAIL-ADMIN-API.md). Tokens/aceitação: [convites e sessões](MAIL-USERS-INVITATIONS.md). A edição de papéis administrativos, a gestão visual de sessões e a criação/ativação de domínios/caixas não fazem parte desta interface.

## Navegação e autorização

O Mail mostra **Administração do Mail** quando a sessão informa `canAdminister=true`. `/mail/admin` segue a arquitetura de `/mail`: entrega uma estrutura estática sem dados privados, consulta a sessão e só então carrega os catálogos. Sem sessão/capacidades, apresenta mensagem de acesso indisponível e retorno ao Mail, sem dados ou formulários administrativos.

O frontend usa as capacidades apenas para navegação. **Todas as leituras/mutações passam pelas APIs existentes**, que revalidam sessão, usuário, tenant, membership e papel. Não há autoridade alternativa no cliente, busca de mensagens/anexos/credenciais ou diretório global por e-mail. Administração não concede leitura de conteúdo.

O seletor contém organizações administráveis. As listas vêm filtradas pelo backend conforme organização/domínio/caixa. Convites e ações de membership aparecem no contexto organizacional indicado pela sessão; chamadas diretas continuam sujeitas aos guards. Papéis, conta global e estados de caixas/domínios são somente de leitura.

Catálogos usam páginas de 25 e **Carregar mais**, com cursor opaco. Os seletores usam registros carregados; o formulário explica como carregar outras opções. IDs são apresentados quando o label relacionado ainda não está carregado; não se informa contagem parcial como total. Tabelas têm região de rolagem acessível por teclado para telas menores.

Trocar organização desmonta o contexto anterior, descartando edições/confirmação/link de convite e cancelando carregamentos. Atualizar/salvar limpa os dados anteriores enquanto consulta o novo estado. 401/revogação ou recusa administrativa remove o contexto; erro de delegação explica a recusa sem conceder acesso.

## Operações e confirmações

- **Grants:** caixa/usuário e booleans separados de leitura, envio e gerenciamento. Antes de editar, percorre as páginas da caixa até encontrar o usuário ou esgotar a lista; linha não carregada não significa grant ausente. Revisão mostra organização, alvo, caixa e os três valores completos. Nenhum bit é ligado automaticamente. Revogação remove o grant inteiro, preservando mensagens, anexos e papéis.
- **Membership:** suspensão afeta somente a organização; sessões globais e outras organizações permanecem. Reativação pode restaurar grants/papéis antigos, sujeita ao teto do ator. O backend protege o último administrador ativo. Não há desativação global de conta.
- **Convites:** e-mail, validade 1–168 horas e UUID conhecido opcional de usuário existente. Confirmação explica a ausência de grants/papéis automáticos. O link é exibido uma vez em campo selecionável, sem envio automático, URL do painel, localStorage ou sessionStorage. Ocultar, trocar organização, sair/recarregar ou revogar o convite correspondente elimina a exibição; a lista não recupera o token.

Cada escrita exige diálogo com alvo/organização explícitos, foco inicial em **Cancelar**, Escape e restauração de foco. A confirmação fica bloqueada enquanto grava, evitando duplo clique; não há atualização otimista ou retry automático. Em falha de rede/503, cancelar e atualizar para conferir o resultado antes de repetir. Convite cujo link não chegou deve ser revogado antes de emissão deliberada de outro.

PUT mantém o contrato completo existente, sem garantia atômica de detecção de edição concorrente; coordenar alterações entre administradores. O painel não contorna delegação, membership inativa, sessão revogada ou proteção do último administrador.

## Validação e rollout

`npm run smoke:mail:admin` executa Playwright desktop/mobile. A UI pode ser local ou Preview, mas **toda API Mail é interceptada e encaminhada aos handlers reais com banco local isolado**: guards, transações e auditoria processam os cliques. Nenhuma mutação chega ao Turso remoto ou a providers; as fixtures são eliminadas ao encerrar o processo, inclusive no Windows.

Casos: entrada autorizada/não autorizada; múltiplas organizações; administrador de caixa sem leitura; delegação negada no backend; grants criados/editados/revogados; grant existente após a primeira página de 100 preservado; suspensão/reativação sem afetar outro tenant/sessão global; último administrador; convite criado/cancelado/revogado; token somente em hash; link descartado na troca de organização; sessão revogada; paginação; teclado/diálogo e responsividade. A suíte de backend existente cobre também domínios, CSRF, concorrência e conteúdo.

Evidências/screenhots em `.vercel/admin-ui/`, ignorados pelo Git. CI executa testes existentes, typecheck, build e suítes de compositor/OIDC/convites/painel. Preview automático conferido contra o SHA da PR; resultados registrados na issue #20.

PR **aberta para revisão**, sem merge/produção. Sem migração: não repetir 0007/0008. Não emitir convites reais, conceder grants ou suspender pessoas em produção durante os testes. Quota20/24h, DNS, Resend, Sending, Receiving, Notifications, credenciais e caixas permanecem iguais. Onboarding real da segunda conta Google continua pendente de autorização/teste próprios.

Rollout futuro somente GitHub → Vercel, sem deploy manual redundante. Em falha, corrigir a interface preservando APIs, auditoria e guards atuais.
