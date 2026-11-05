# Preparação do piloto Mail — issue #12

Estado em **04/11/2026 (America/Fortaleza)**. R2 provisionado, testado e configurado na fase A; as fases B/C exigem autorização explícita. Nenhum DNS foi alterado, nenhum e-mail externo foi enviado/recebido e Notifications continua bloqueado.

## R2 dedicado

- Bucket `todoku-mail`, classe Standard, localização ENAM, jurisdição default. Nenhum bucket de outro projeto foi modificado.
- Acesso `r2.dev` explicitamente desativado, lista de domínios customizados vazia e CORS inexistente (API retorna 404 para configuração ausente).
- Lifecycle `mail-private-retention-backstop`, somente prefixo `mail/`: expiração por idade de **91 dias** (`7862400` segundos) e aborto de uploads multipart incompletos após **24h**.
- A aplicação continua usando expiração lógica de 30 dias por padrão, configurável entre 1–90 dias, e coleta de uploads incompletos após 24h. O lifecycle é uma proteção contra órfãos; os 91 dias evitam remover conteúdo antes do maior prazo permitido. A execução da regra pelo provedor não é instantânea. Não representa um teste de exclusão após 91 dias.
- Credencial S3 Object Read/Write fornecida pelo operador e **restrita ao bucket `todoku-mail`**. Verificação após o ajuste: listagem vazia no bucket próprio retornou 200 e no bucket de outro projeto retornou **403**, sem obter conteúdo ou alterar objetos de outro projeto. A chave inicialmente ampla não foi distribuída na Vercel.
- PUT/GET/DELETE remotos aprovados com o adaptador da aplicação e a credencial já restrita. As quatro variáveis de servidor e `TODOKU_MAIL_STORAGE=r2` foram configuradas em Production, Preview e Development; entram em cada novo deployment automático. As duas credenciais são do tipo Secret em Production/Preview; Development usa Config privado da equipe. Cópias locais permanecem em arquivos ignorados.

### Prova remota de persistência

Após restringir a credencial, o `smoke:mail:r2` gravou e conferiu 62 bytes sintéticos no bucket privado, com SHA-256 `ebba975eb7b17089e36af3ec7375c6df332b150f1635d39f66d4cefe2860d963`. PUT **200**, GET **200**, DELETE **204**, GET após exclusão **404**. O objeto foi eliminado ao final. A requisição anônima ao objeto existente retornou **400**, XML `InvalidArgument` / `Authorization`: o endpoint S3 do R2 usa esse erro para ausência de autenticação. O teste reconhece essa resposta específica além de 401/403; não aceita qualquer erro 400. Nenhum e-mail externo foi usado.

Wrangler local autenticado permitiu conferir novamente o bucket privado e o lifecycle. `cf` oficial foi instalado com credenciais OAuth criptografadas no keyring do Windows; os dois fluxos de autorização concederam somente leitura básica e a administração de tokens retornou 403. A chave S3 foi então fornecida pelo operador em `.env.r2.local`, ignorado. A autorização OAuth não substitui a restrição de bucket dessa chave.

O comando `npm run smoke:mail:r2` usa credenciais em `.env.local` ou `.env.r2.local`, ambos ignorados. Cria uma chave aleatória sob um tenant sintético, compara os bytes baixados, exige negação de GET anônimo, exclui em `finally` e confirma GET autenticado 404. Não consulta o banco ou usa mensagens reais. A saída contém somente bucket, tamanho, hash dos bytes sintéticos e status HTTP; nunca credenciais, assinatura ou corpo.

As variáveis de servidor são `TODOKU_R2_ACCOUNT_ID`, `TODOKU_R2_BUCKET`, `TODOKU_R2_ACCESS_KEY_ID` e `TODOKU_R2_SECRET_ACCESS_KEY`. Foram configuradas por stdin após o teste remoto e de escopo. Publicação exclusivamente via commit/push e integração GitHub/Vercel. Para rotação futura, repetir teste e checagem de escopo antes de substituir as variáveis; manter Receiving pausado se perder o acesso ao storage.

## Resend preparado e pausado

- Domínio `todoku.com.br`, ID `d59cb6bd-4f3b-421d-a432-151d5dd23c7f`, região `sa-east-1`, status `not_started`, Receiving **disabled**.
- Sending é a capacidade padrão do cadastro; o Resend exige pelo menos uma capacidade habilitada. O domínio não está verificado, seus DNS de envio não foram publicados e Todoku não recebeu autorização/chave para enviar. O alvo após autorização é **somente recebimento**, com Sending desativado ao habilitar Receiving.
- Webhook dedicado `8ff3cf37-cc2f-4d76-814b-39f1386e841c`, **disabled**, inscrito somente em `email.received`:
  `https://todoku.com.br/api/webhooks/mail/resend/6fe7be6c-e216-4228-acf0-b85e11ec3b51`.
- Novo signing secret guardado apenas no arquivo ignorado `.env.mail-provider.local`; source, domínio e identidades continuam desativados no banco único `todoku`. A credencial BYOK para ler recebidos será provisionada com o escopo suportado pelo provedor durante a ativação autorizada.
- Um webhook preparatório foi substituído e excluído após a consulta do CLI inesperadamente retornar `signing_secret`. O novo segredo não foi exibido. Tratar **também `webhooks get`** como saída sensível e filtrar qualquer resposta antes de imprimir; a documentação do CLI não correspondeu ao comportamento observado.

### Registros exatos retornados pelo Resend

Os registros abaixo foram obtidos por `domains create/get` com Receiving desativado. **Nenhum deles foi publicado.**

| Finalidade | Tipo | Nome relativo | Valor exato | Prioridade |
| --- | --- | --- | --- | --- |
| DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQD71BFqRGy+QphWxXSei3BmNyY4uiXLnh6SHkqUeKbN5wNnqQELGePt1nqGKZMI6o9FnYZQ4PaO/988vALVvgsNgH8C8I2Ms29y9PWCm5gRoXg9tTmL88u94yZqgVzAIVqZ2NlKm9rBSR/y4DnoywqAPjSyL2eB0uFG7sZ03tBA0QIDAQAB` | — |
| Envio/SPF | MX | `send` | `feedback-smtp.sa-east-1.amazonses.com` | 10 |
| Envio/SPF | TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
| Envio/SPF | CNAME | `rsend` | `send.forge.rmta.net` | — |

TTL apresentado pelo Resend: `Auto`. Os três registros de envio/SPF não fazem parte do plano de recebimento somente. O DKIM é exigido pelo Resend também para domínio que só recebe.

**MX de recebimento ainda não fornecido pela API.** A documentação informa que o valor é apresentado após habilitar Receiving, ação proibida sem aprovação pela fase B. Portanto, não existe diff MX executável/aprovado nesta etapa. Não confundir o MX `send` de feedback acima com o MX de recebimento do apex e não copiar exemplos da documentação.

## Inventário DNS preservado

Inventário inicial consultado pela API Cloudflare: cinco registros, TTL Auto, DNS-only. A conferência pública posterior confirmou os mesmos valores abaixo e ausência do TXT DKIM novo (`NXDOMAIN`). O OAuth local do operador não permite listar/editar DNS; revalidar o acesso necessário antes de qualquer fase externa autorizada.

| Tipo | Nome | Valor | Prioridade |
| --- | --- | --- | --- |
| A | `todoku.com.br` | `76.76.21.21` | — |
| CNAME | `www.todoku.com.br` | `cname.vercel-dns.com` | — |
| MX | `todoku.com.br` | `.` (Null MX) | 0 |
| TXT | `todoku.com.br` | `v=spf1 -all` | — |
| TXT | `_dmarc.todoku.com.br` | `v=DMARC1; p=reject;` | — |

## Ativação e reversão a revisar

Checagem publicada nesta preparação: `/`, `/mail` e `/api/health` retornaram 200; inbox sem sessão retornou 401; worker Mail autenticado retornou `receiving_disabled`; teste Notifications retornou 403 sem envio. Banco: source piloto disabled, duas identidades disabled, retenção 30 dias, nenhum source fixture ativo. Production/Preview/Development mantêm Receiving false; a configuração de storage foi atualizada para r2. Tipo, 54 testes, build e CI passaram, incluindo a revisão do erro de autorização R2. O smoke autenticado espera `storageReady=true` no novo deployment, duas identidades e caixa vazia, Receiving false, worker pausado, Notifications bloqueado e logout com revogação. O primeiro fluxo de recebimento real na Vercel continua reservado à fase C.

1. Conferir CI e o novo deployment automático da fase A com storage configurado antes de pedir a aprovação externa.
2. Solicitar autorização específica para habilitar Receiving no Resend e desativar Sending **mantendo Null MX e a flag global false**, apenas para obter o MX exato. Não interpretar isso como autorização para alterar DNS.
3. Mostrar novamente o inventário e o diff com o MX real. Proposta limitada ao apex de `todoku.com.br`: substituir Null MX pelo MX e prioridade exatos do Resend; adicionar apenas o TXT DKIM acima e outra verificação realmente exigida, se houver. Preservar A, CNAME www, SPF apex e DMARC. Não publicar os registros de envio/SPF.
4. Somente após autorização explícita do diff, alterar DNS, verificar resolução pública e domínio/recebimento no Resend. Revalidar site e `/api/health` antes/depois. Nenhum outro domínio, bucket ou Google Workspace está no escopo.
5. Provisionar BYOK criptografado no source existente; ativar apenas as identidades piloto aprovadas, habilitar o webhook e `TODOKU_MAIL_RECEIVING_ENABLED` somente no ambiente aprovado. Publicar pela integração GitHub/Vercel.
6. Somente com autorização de teste, uma mensagem de uma caixa externa controlada pelo responsável para `contato@todoku.com.br`; nunca usar Notifications. Verificar webhook/job/worker/R2/inbox autenticada, replay e auditoria, sem copiar conteúdo privado para evidências.

Reversão: desligar a flag global de recebimento e o webhook/source; publicar a mudança de configuração via GitHub/Vercel; desativar Receiving no Resend preservando a capacidade mínima exigida pelo provedor; restaurar exatamente o MX `0 .` e remover apenas registros novos desta ativação. Preservar A/CNAME e TXT defensivos originais. Verificar DNS público, site e endpoints pausados. Manter dados/auditoria e objetos privados até a retenção normal; não excluir conteúdo recebido como parte da reversão.

**Limites que permanecem:** `TODOKU_MAIL_RECEIVING_ENABLED=false`, `TODOKU_TEST_SEND_ENABLED=false`, marketing desabilitado. A issue #12 permanece aberta até a fase C autorizada e validada; este relatório não comprova recebimento externo.

Referências: [issue #12](https://github.com/mtcporto/todoku/issues/12), [R2 lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [credenciais R2](https://developers.cloudflare.com/r2/api/tokens/), [domínios de recebimento Resend](https://resend.com/docs/dashboard/receiving/custom-domains), [capacidades no cadastro Resend](https://resend.com/docs/api-reference/domains/create-domain).
