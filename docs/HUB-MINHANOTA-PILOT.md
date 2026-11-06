# MinhaNota → Todoku Hub — piloto operacional

## Escopo em 06/11/2026

Primeira integração do Communication Hub, somente para boas-vindas após login
Google no MinhaNota. O responsável autorizou em um único lote a preparação
operacional, credencial exclusiva, variáveis de Production, merge da PR #3 e
teste controlado em dry-run. Essa autorização não libera entrega externa.

- Todoku: documentação de inicialização integrada na [PR #33](https://github.com/mtcporto/todoku/pull/33),
  commit `bfc7de764d033f44874187a90291ebc5c7c45383`, Production READY.
- MinhaNota: [PR #3](https://github.com/mtcporto/minhanota/pull/3) revisada no head
  `92f51218a49eaa2d4685ec1a850c241a339ecdc6`, integrada por squash em
  `797886c6f8d556d3710d7cb58f3fd58819f3c57b`.
- Deployment automático `dpl_21v7oTCtdofoGBD9sZUeshwCryKE`, READY; alias
  `https://minhanota.app` e ID do deployment no HTML conferidos.
- [CI da main](https://github.com/mtcporto/minhanota/actions/runs/42249224823)
  aprovado. Cinco testes do consumidor, typecheck, build e smoke integrado
  local com dois bancos isolados também aprovados antes da publicação.

## Configuração do Hub

| Campo | Valor |
| --- | --- |
| Tenant / aplicação | `todoku/minhanota` |
| Nome | `MinhaNota` |
| Remetente | `MinhaNota <notificacoes@minhanota.app>` |
| Modo | `dry_run` |
| Configuração Hub | `0abab748-94c0-4aa8-b408-cb3ac71e4be6` |
| Template / versão | `minhanota.welcome@1` |
| Assunto | `Boas-vindas ao MinhaNota` |
| Variável obrigatória | `firstName`, texto |
| Única comunicação habilitada | `user.welcome` |
| Verificação de e-mail, recuperação e alerta de segurança | Desabilitados |
| Credencial de ingestão | Exclusiva, escopo `events:write`; somente hash no Turso |
| Chave Resend / segredo de webhook na configuração nova | Ausentes |

Texto do template: `Olá, {{firstName}}! Sua conta MinhaNota está pronta. Acesse https://minhanota.app para começar.`

O tenant não tinha configuração de remetente para cadastrar sua primeira
aplicação pelo painel. O cadastro inicial autorizado usou transação com
`requireHubAdministrator` revalidando a sessão/UUID/tenant e `hubAudit` para
aplicação e credencial. Não reutilizou configurações revogadas ou de outro
tenant. Somente metadados de remetente foram registrados, sem criar domínio,
chave ou configuração no Resend.

A adoção do catálogo usou a API administrativa autenticada existente, com nome
`MinhaNota`. Template, associação de evento e prévia foram configurados pelo
painel publicado em sessão isolada, com igualdade entre confirmação e payload
conferida. Desktop e celular verificados. Não houve mudança de backend,
autenticação ou migração; 0009 e bootstrap do administrador não foram repetidos.

## Variáveis e credencial

Somente no projeto Vercel **minhanota**, target **Production**:

| Variável | Configuração |
| --- | --- |
| `TODOKU_ORIGIN` | `https://todoku.com.br` |
| `TODOKU_TENANT_ID` | `todoku` |
| `TODOKU_APPLICATION_ID` | `minhanota` |
| `TODOKU_APPLICATION_TOKEN` | Secret/Sensitive, sem valor neste documento |
| `MINHANOTA_TODOKU_ENABLED` | `true` |

O opt-in permaneceu `false` até Hub, template, credencial e destinatário elegível
serem conferidos. Foi habilitado antes do merge, de modo que a publicação
automática recebesse as variáveis. Preview e Development não receberam essas
cinco variáveis. Nenhum deploy manual ou redundante foi executado.

O token foi passado diretamente, em memória, por stdin ao CLI autenticado da
Vercel. Não foi escrito em arquivo, commit, screenshot ou log. Uma validação do
formato da resposta no cliente falhou depois da criação; consulta remota
confirmou a variável Sensitive e seu target antes de prosseguir. Não foi criada
segunda credencial nem repetida a criação da variável.

## Reconferência operacional e validações distintas

Em 06/11/2026, a continuação consultou as duas branches locais e a `main` no
GitHub, metadados autenticados da Vercel, health HTTP e os dois bancos, somente
em leitura. Nenhuma configuração foi repetida:

- Todoku `main` em `bfc7de764d033f44874187a90291ebc5c7c45383`;
  deployment `dpl_CU7c12ahZownypDBamuQY3yc9DV9`, READY.
- MinhaNota `main` em `797886c6f8d556d3710d7cb58f3fd58819f3c57b`;
  deployment `dpl_21v7oTCtdofoGBD9sZUeshwCryKE`, READY, também identificado
  no HTML de `https://minhanota.app` (HTTP 200).
- `https://todoku.com.br/api/health`: HTTP 200, `ready`, ingestão `durable`,
  entrega padrão `dry_run`, marketing `disabled`.
- 0009 presente; tenant/aplicação ativos; configuração acima ativa em
  `dry_run`, `send_count=0`, sem chaves de envio/webhook.
- Conteúdo, assunto e variável `firstName` do template conferidos no banco;
  somente o binding `user.welcome` habilitado.
- As cinco variáveis do consumidor continuam exclusivamente em Production;
  origem/tenant/aplicação correspondem à tabela acima, opt-in `true`.
- Duas linhas em `emails_boas_vindas`, zero em `emails_boas_vindas_hub`;
  zero eventos em `todoku/minhanota`. Nenhuma reserva ou histórico alterado.

| Trecho | Estado desta continuação | Evidência necessária |
| --- | --- | --- |
| API → Todoku Hub | **Bloqueado; não validado** | HTTP autenticado 202, snapshot, processamento dry-run, status, auditoria e replay |
| Login Google → MinhaNota → Todoku Hub | **Pendente; não validado** | Login legítimo e reserva/recibo do consumidor correlacionados ao evento do Hub |

O contrato existente permite `POST /api/v1/events` com `type=user.welcome`,
`tenantId=todoku`, `applicationId=minhanota`, destinatário autorizado e
`data={"firstName":"Teste"}`. A supressão de boas-vindas legadas ocorre no
consumidor, não nesse endpoint. Dry-run não exige allowlist de transporte;
isso não dispensa autorização do destinatário pelo responsável.

**Bloqueio de credencial:** a leitura autenticada da variável existente
`TODOKU_APPLICATION_TOKEN` com `decrypt=true` devolveu metadados Sensitive,
sem valor utilizável. Não há cópia em `.env.local` do MinhaNota. Nenhum token
foi gerado, rotacionado ou exposto. O responsável estava indisponível para
fornecer acesso privado à credencial ou autorizar alternativa. Não foi feito
POST de ingestão; health e consultas SQL não substituem essa prova.

### Retomada do teste HTTP controlado

1. Disponibilizar a credencial existente somente em memória/arquivo privado
   fora do Git, nunca no chat/log. Confirmar o destinatário autorizado.
   Se não houver cópia, solicitar autorização específica antes de criar uma
   credencial temporária restrita, com expiração e revogação ao final; não
   substituir o token Production do consumidor.
2. Reconfirmar configuração ativa dry-run e template. Gerar UUID/instante e
   chave própria, como `minhanota-api-validation-<UUID>`, sem usar a chave
   `minhanota-welcome-<hash>` do consumidor. Preservar o mesmo payload para
   retries; não escrever nas tabelas de boas-vindas do MinhaNota.
3. Fazer o POST na origem Production e exigir 202. Repetir o payload idêntico,
   exigindo o mesmo `eventId`, `replay=true` e apenas uma outbox/auditoria.
4. Conferir payload persistido, snapshot `minhanota.welcome@1`, remetente,
   assunto/conteúdo renderizado e modo. Aguardar cron dry-run; conferir GET de
   status, fila terminal `cancelled`, entrega `dry_run`, tentativa
   `provider=dry_run` bem-sucedida, auditorias de aceite/processamento,
   ausência de ID de provedor e orçamento reservado zero.
5. Somente após essas provas, registrar **API → Todoku Hub validado**.
   Manter **login Google → MinhaNota → Todoku Hub pendente**.

### Alternativa segura para o callback Google

Usar outra conta Google **já existente e verificada**, disponível e com
consentimento de sua titular, sem histórico/reserva de boas-vindas. Conferir
elegibilidade em leitura antes de login legítimo pelo navegador. O código
permite sessão sem empresas autorizadas: não criar contas fiscais, adicionar
à lista de acesso, vincular CNPJ ou conceder papéis/grants. Não fabricar tokens,
códigos OAuth ou callbacks. Sem participante elegível disponível, essa
validação continua pendente.

Contas com boas-vindas antigas permanecem suprimidas. Nenhuma reserva ou sucesso
legado foi apagado para provocar novo evento. O código já aceita login de uma
conta Google verificada sem acesso fiscal; a lista de contas da Pixel Vivo é
uma permissão de conteúdo, não exigência para o piloto de comunicação. Não
foram alterados autenticação, vínculos de empresas ou grants fiscais.

Depois do login autorizado, conferir a reserva durável
`emails_boas_vindas_hub` no MinhaNota, aceite autenticado e snapshot no Hub,
template/versionamento, tentativa dry-run, auditoria e replay do mesmo payload.
Não substituir a prova do callback por chamada local do consumidor ou evento
controlado diretamente no Hub. O teste direto pode comprovar somente API → Hub.
O teste local de perda do recibo continua evidência separada.

## Backup, preservação e recuperação

Antes das alterações foram exportados os bancos `todoku` e `minhanota`; DB e
WAL de cada exportação foram restaurados juntos em cópias locais. Integridade
ok, FKs sem violações e digests/contagens de todas as tabelas iguais aos bancos
selecionados (43 no Todoku e 6 no MinhaNota). Os originais foram conferidos por
SHA-256 e mantidos privados em `.vercel/minhanota-pilot-20261106/`, com ACL restrita
à conta executora e fora do Git. Preservar cada par **DB + WAL**, não só o DB.

Relatórios de configuração e imagens do painel ficam nesse diretório privado.
Não publicar destinatário, nome do participante, payload pessoal ou segredo.
O armazenamento de reservas do consumidor contém dados pessoais e exige os
mesmos controles de acesso/retenção do banco operacional.

Em falha, desabilitar o opt-in de Production e publicar pelo fluxo GitHub/Vercel
autorizado; manter a configuração Hub em dry-run, preservar auditoria/reservas
e investigar antes de retomar. Não fazer fallback Resend, apagar recibos,
reaplicar migrações ou restaurar o banco inteiro sobre atividade posterior.
Restauração remota exige procedimento e aprovação próprios.

Fiscal, certificado A1, ADN/SEFIN, DNS, Cloudflare, Resend e plano contratado
permanecem fora desta operação. O Mail conserva sua política independente.
Qualquer primeiro envio externo exige autorização e evento novos; um evento
dry-run não deve ser convertido em entrega real.
