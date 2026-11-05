# Compositor — issue #17

Validação em 2026-11-05, Chromium, build de produção local. A interface usa as mesmas APIs de rascunho e fila já existentes; nenhuma alteração de backend, migração ou configuração de infraestrutura faz parte desta mudança.

## Comportamento

- Cabeçalho e rodapé ficam fora da área rolável. A altura e o deslocamento seguem `VisualViewport`; os botões ficam disponíveis mesmo com o editor ou anexos rolados.
- De/Para compactos; Cc e Cco recolhidos em mensagens novas. Rascunhos com valores abrem os campos correspondentes; recolher não apaga os destinatários e mostra sua contagem.
- Anexos em cartões com nome, tamanho e remoção individual. A seleção mantém os limites de cinco arquivos/2 MiB e o armazenamento privado existente.
- Estados de leitura dos anexos, alterações pendentes, salvando e salvo. Na fila, o aviso orienta acompanhar o status em Enviados; enfileirar não afirma entrega.
- Durante operações, controles bloqueados e trava síncrona impedem duplo envio. Falhas mantêm o rascunho disponível.
- Tab/Shift+Tab ficam no modal, inclusive durante um salvamento pendente; Escape/fechar protegem alterações. A navegação da página também tem proteção enquanto há alterações ou operação em andamento. Ao fechar, o foco retorna ao acionador ou a Escrever caso o acionador tenha sido desmontado.

## Evidências

| Dimensão | Mensagem nova | Rascunho com anexo | Altura reduzida |
| --- | --- | --- | --- |
| Desktop 1440×960 | [Captura](desktop-new.png) | [Captura](desktop-saved.png) | [1440×540](desktop-reduced-viewport.png) |
| Mobile 390×844 | [Captura](mobile-new.png) | [Captura](mobile-saved.png) | [390×430](mobile-reduced-viewport.png) |

[Resultado estruturado](results.json). Os testes cobrem Cc/Cco, salvar/reabrir/editar, anexar/remover/rejeitar excesso, proteção contra descarte, foco, ausência de overflow, posição dos botões, falha de fila, duplo clique e distinção entre fila e entrega. `typecheck`, os 71 testes existentes e `build` passaram localmente. A CI executa também este teste de navegador após o build.

## Reproduzir

Com Node 24 e dependências instaladas:

```sh
npm run build
npm run start -- --hostname 127.0.0.1 --port 3039
# Em outro terminal:
npm run smoke:mail:composer
```

O teste intercepta **todas** as rotas `/api/mail/`, aborta origens externas e não autentica, lê ou altera banco, R2, Resend ou configurações privadas. Não precisa de `.env`. `TODOKU_UX_ORIGIN` permite testar os assets reais de um preview; `VERCEL_OIDC_TOKEN`, quando necessário, é enviado apenas nos recursos reais daquela origem para atravessar sua proteção. O token não é registrado.

As imagens contêm somente dados sintéticos `.invalid`. A redução do viewport exercita o ajuste a `VisualViewport`; **não é uma verificação do teclado físico de iOS/Android**. Essa checagem em dispositivo continua como validação complementar. A suíte não afirma entrega externa nem revalida upload remoto: a persistência, segurança e autorização do backend são cobertas pelos testes existentes. Receiving, Sending, Notifications, DNS e identidades de produção permanecem sob os controles das issues de infraestrutura.
