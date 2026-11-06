# Hub — biblioteca global, identidade e templates

## Escopo

A aplicação detecta o acontecimento e emite o evento. O Todoku resolve o
binding da aplicação, congela o conteúdo e utiliza a entrega existente.
Biblioteca, cadastro, personalização e prévia **não enviam mensagens**.
Marketing permanece desabilitado. Nenhum emissor de outro projeto foi criado.

Implementação: biblioteca curada em `src/lib/hub/catalog.ts`, linguagem de
templates existente em `src/lib/hub/templates.ts`, estrutura visual reutilizável
em `src/lib/hub/presentation.ts` e administração existente em `/hub`.
Não há segundo catálogo operacional, fila, API de ingestão ou transporte.

## Biblioteca inicial

| Evento | Modelo |
| --- | --- |
| `user.welcome` | `welcome` |
| `user.password_reset` | `password-reset` |
| `user.email_changed` | `email-changed` |
| `user.security_alert` | `security-alert` |
| `user.login_code` | `login-code` |
| `account.invitation` | `invitation` |
| `notification.general` | `general-notification` |
| `notification.action_required` | `action-required` |
| `billing.payment_confirmed` | `payment-confirmed` |
| `billing.payment_failed` | `payment-failed` |
| `billing.receipt` | `receipt` |
| `support.ticket_created` | `ticket-created` |
| `support.ticket_updated` | `ticket-updated` |
| `user.email_verification` | `email-verification` — modelo existente preservado |
| `user.welcome` | `minhanota.welcome` — alternativa visual específica, fora do pacote padrão |

O cadastro e a adoção apresentam um pacote de 14 modelos **opcionais**.
É permitido selecionar nenhum. Só um modelo por evento pode integrar o pacote.
Todas as associações iniciais ficam desabilitadas; nenhum evento é emitido.
Para aplicações existentes, nada é instalado automaticamente.

“Usar modelo” copia o conteúdo para `hub_templates` da aplicação, criando
uma versão imutável. Se não existir binding, cria um desabilitado. Se já
existir, **não altera** template, versão ou ativação do binding.
A cópia pode ser personalizada sem modificar a biblioteca nem outras aplicações.
“Associar outro evento ou versão” continua sendo a ação explícita para escolher
qual versão será utilizada. Desabilitar continua bloqueando novos pedidos e
trabalhos pendentes conforme a política já existente.

## MinhaNota — apresentação recuperada, não transporte legado

Referência: `mtcporto/minhanota`, commit `95a7e68`,
`src/lib/email/boas-vindas.ts`. Somente a apresentação foi recuperada:

- Assunto `Boas-vindas ao MinhaNota`.
- Título `Bem-vindo ao MinhaNota!` e saudação com `{{firstName}}`.
- Explicação sobre conectar a empresa e acompanhar notas fiscais de serviço.
- Botão `Acessar MinhaNota`, URL `https://minhanota.app`.
- Azul `#163b73` e rodapé de segurança original.
- HTML responsivo e texto equivalente, incluindo URL do botão e rodapé.

`minhanota.welcome@1` é imutável e já possui evidências auditáveis.
Não editar essa linha nem converter seus snapshots. Copiar o modelo
`minhanota.welcome` na aplicação piloto cria **@2** quando somente @1 existe;
conferir o número retornado, pois novas personalizações podem gerar @3 etc.
Depois da prévia, apontar explicitamente `user.welcome` para a nova versão,
mantendo o estado de ativação escolhido. O contrato permanece somente
`data.firstName`; o consumidor MinhaNota não precisa mudar.

Procedimento sem envio: aplicar 0010 com aprovação operacional, abrir a
aplicação MinhaNota, conferir a identidade, copiar o modelo, gerar prévia,
conferir HTML/texto e trocar o binding. Não criar eventos de produção para
testar o visual, apagar reservas, revalidar transporte ou habilitar flags.
O piloto anterior permanece concluído e é uma evidência histórica separada.

## Identidade e versionamento

Identidade por `(tenant, application)`: nome, logotipo HTTPS, cores principal e de fundo hexadecimais,
site HTTPS, suporte HTTPS e assinatura. Não altera remetente, credenciais,
verificação de domínio ou política de envio.

Templates visuais reutilizam um layout responsivo de e-mail com estilos inline.
Conteúdo, título, botão e rodapé são dados, não HTML arbitrário. A identidade
vigente entra somente em **novos snapshots**; alterar a marca não reescreve
mensagens aceitas. Templates simples antigos sem apresentação preservam
exatamente seu renderizador anterior. Publicar versão não troca binding.
Replay devolve o aceite original, mesmo após mudança de identidade ou binding.

Variáveis são obrigatórias e estritas (`text` ou `https_url`). Botão aceita
URL HTTPS literal ou uma variável inteira `{{actionUrl}}` declarada
`https_url`; não aceita composição parcial de URL. Conteúdo e atributos HTML
são escapados. Não há scripts, includes, helpers ou avaliação de expressões.
A aplicação gera códigos e links de autenticação; o Hub não cria identidades,
senhas, convites, tokens ou permissões.

Prévia HTML em iframe sandbox, com CSP restritiva e sem referer; texto também
disponível. Logotipos HTTPS configurados podem ser carregados na prévia.
Não usar dados reais em URLs de logotipo nem payloads de exemplo.

## Administração existente ampliada

Todos os caminhos abaixo continuam sob `/api/hub/tenants/:tenant/applications`.
Sessão, grant explícito, origem, autorização transacional e auditoria existentes
são preservados. Os endpoints não retornam segredos nem conteúdo de mensagens.

| Operação | Alteração |
| --- | --- |
| GET coleção/aplicação | `globalTemplates`; aplicação também retorna `branding` e `presentation` por versão |
| POST cadastro / `:app/catalog` | `catalogItems?: string[]`; ausência usa pacote padrão; `[]` não copia modelos |
| POST `:app/models` | `{modelId}` copia uma versão; não substitui binding existente |
| POST `:app/branding` | `{name,logoUrl?,primaryColor?,backgroundColor?,websiteUrl?,supportUrl?,signature?}` |
| POST `:app/templates` | Contrato anterior mais `presentation?`: `{heading,buttonLabel?,buttonUrl?,footer?}` |
| POST `:app/preview` | Mesmo contrato de entrada; retorna também HTML, além de assunto/texto/versão |
| POST `:app/bindings` | Contrato anterior, inclusive novos tipos de evento e ativação explícita |

Eventos específicos dos projetos são apenas [propostas inativas](HUB-EVENT-CANDIDATES.md).

## Migração e publicação

`0010_hub_template_catalog` adiciona somente duas colunas JSON anuláveis:
`hub_templates.presentation_json` e `hub_applications.branding_json`.
Não atualiza linhas, versões, bindings, configurações de transporte ou Mail.
Não inicializa modelos em aplicações existentes. Não roda no build/request.

Ordem operacional: backup/ponto de recuperação do banco único `todoku`,
aprovação da migração, execução explícita com o mecanismo existente,
integridade/FKs, publicação automática GitHub/Vercel e conferência do SHA/READY.
Sem 0010, administração de aplicações retorna `503 hub_catalog_setup_required`;
sessão continua disponível. Ingestão de aplicações legadas e gerenciadas
anteriores continua compatível enquanto a migração aguarda execução.
Não usar previews com banco compartilhado para testes mutáveis.

Validação local: testes de renderização, catálogo/variáveis, bindings,
rollback/auditoria, isolamento tenant/aplicação, snapshots, replay e dry-run.
`npm run smoke:hub` usa handlers reais e SQLite isolado em desktop/celular,
incluindo biblioteca, identidade, personalização e iframe. Nenhum teste envia.
