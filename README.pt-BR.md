<!-- golive-translation: lang=pt-BR; source=README.md; source-commit=014734c; reviewed=false; updated=2026-09-26 -->

# GoLive

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

**Coloque em produção o produto que o seu agente construiu: hospedagem, banco de dados, autenticação, domínio, e-mail e pagamentos — nas suas próprias contas. Depois, transfira a operação ou desmonte tudo.**

Seu agente de código monta um app em minutos. Mas levar isso até usuários de verdade ainda significa
contas, hospedagem, bancos de dados, domínios, segredos e serviços conectados. O GoLive é a Agent
Skill de código aberto para esse trabalho: ela **detecta do que o seu app precisa, planeja as
mudanças exatas, pede a sua aprovação, aplica tudo com os seus próprios logins e verifica o que
realmente funciona** — depois registra o que criou, reconfere sob demanda se algo mudou (drift) e
consegue remover tudo outra vez.

Automatize as partes que os provedores expõem. Guie você pelas partes que precisam de uma pessoa.
Verifique o que dá para observar e deixe claro o que ficou inacabado. Sem conta no GoLive, sem
backend hospedado e sem telemetria do produto.

> **Alpha inicial · 0.1.0-alpha.3**
> Testes ao vivo descartáveis já cobrem seis jornadas: **hospedagem** (Vercel, Netlify), **banco de
> dados** (Supabase, Neon), **DNS de domínio próprio** (Porkbun, GoDaddy), **e-mail transacional**
> (Resend), **pagamentos em modo de teste** (Stripe) e **autenticação do Supabase**, além do caminho
> de desinstalação via `teardown`. O documento de propriedade e a checagem de drift sob demanda do
> `golive status` estão implementados e com cobertura de testes (o `golive status` também rodou em
> modo somente leitura numa validação ao vivo), enquanto o
> [roadmap](README.md#the-full-go-live-checklist-and-roadmap) mais amplo é a nossa direção, não uma
> alegação de que tudo isso já está construído.

## Antes de entregar o acesso de produção

A decisão de dar as suas contas de provedor a um agente se resume a quatro perguntas. Estas são as
respostas deste projeto, com os limites declarados onde eles existem.

- **Você continua aprovando cada escrita.** Nada chega a uma conta real sem um plano que você viu e
  aprovou: o `apply` recusa sem o id desse plano e sem `--yes`, e reconfere a identidade do plano
  antes de escrever, então uma release ou uma configuração alterada invalida a aprovação antiga.
  Escritas de DNS exigem `--confirm-dns`, exclusões exigem `--confirm-destroy`, e passos em modo live
  — pagamentos reais, dados de produção, uma conta de verdade — exigem `--confirm-live`, que agora
  inclui o **primeiro deploy de produção** de um projeto, porque antes bastava aprovar um plano para
  escrever em produção pela primeira vez. Valores de credencial são lidos apenas em processo, nunca
  impressos, e nunca em argumentos, planos, estado ou relatórios; o arquivo onde o golive os guarda é
  texto puro em modo 0600, fora do seu repositório, e não um keychain. Vale nomear um limite: essas
  flags são argumentos que o agente passa em seu nome, e um agente já logado no seu provedor consegue
  escrever lá sem nenhum plano do golive. [Confiança, acesso e controle](docs/TRUST.md) separa o que
  o código impõe do que é apenas uma instrução que se pede ao agente para seguir.
- **A execução para em vez de insistir.** O `apply` para na primeira checagem que falha, na
  confirmação que falta, no pré-requisito ausente ou no provedor que contradiz o plano. Os passos
  seguintes não rodam, e o próximo `apply` retoma daquele passo.
  [Recuperação](docs/RECOVERY.md#the-run-stopped) cobre como ler a falha, quais passos são retomados
  e os casos que exigem uma decisão revisada antes.
- **O rollback é estreito, opcional e nunca automático.** Uma checagem que falha nunca dispara um
  rollback. `release.rollback: true` planeja um único passo que reaponta a produção para um deployment
  anterior que o próprio golive registrou; um deployment criado por um dashboard, por um push no Git
  ou por um pull request não é alvo, e isso não toca em nenhum recurso de dados, DNS, pagamento ou
  e-mail. Hoje só a Netlify suporta esses reapontamentos — na Vercel você corrige a produção no
  dashboard (o adaptador da Vercel não faz nenhuma leitura do que a produção serve). Promoção e
  rollback estão implementados e cobertos por mocks, **sem validação ao vivo**.
- **Nada fica para trás em silêncio — o que não é a mesma coisa que não ficar nada para trás.**
  O `golive teardown` remove apenas recursos que consegue provar que criou, relê a zona de DNS e o
  projeto do host depois de excluir, e nomeia cada sobra que não consegue remover — projetos Supabase
  e Neon, o domínio de envio da Resend, uma zona ou um projeto de host ilegível — num handoff que diz
  o que restou e como remover à mão. Uma remoção também esquece a linha de base que o golive registrou
  para aquele recurso, então o `golive status` não reporta o teardown do próprio golive como drift.

Essas respostas na íntegra: [confiança, acesso e controle](docs/TRUST.md) e
[recuperação](docs/RECOVERY.md). A [arquitetura](docs/ARCHITECTURE.md) é o contrato do produto, o
[escopo de provedores](docs/PROVIDERS.md) diz o que cada provedor faz hoje, o
[registro de validação](docs/VALIDATION.md) separa o que foi exercitado ao vivo do que é apenas
coberto por mocks, e a [distribuição](docs/DISTRIBUTION.md) cobre instalação e atualizações.

[Instalação](README.md#install) · [Usar o GoLive](README.md#use-golive) · [Ver o fluxo](README.md#what-a-run-looks-like) · [Escopo do alpha](README.md#what-this-alpha-supports) · [Roadmap](README.md#the-full-go-live-checklist-and-roadmap) · [Contribuir](CONTRIBUTING.md)

## Instalação

Você precisa de **Node.js 20+**, npm/npx, Git e um agente de código capaz de carregar skills e rodar
comandos. A instalação foi verificada no Codex e no Claude Code; outros clientes não foram
verificados.

**Instale uma vez para todos os seus projetos.** Rode este comando de qualquer diretório:

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

Quando ele pedir, selecione o seu agente: use as setas para navegar, Espaço para marcar e Enter para
confirmar. Essa tela está esperando entrada; a instalação só continua depois que você confirmar.

Para pular a escolha do agente, use o comando do seu agente:

```bash
# Codex
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent codex --yes

# Claude Code
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent claude-code --yes
```

Para instalar em apenas um projeto, rode a partir do repositório desse projeto e omita `--global`.

**Ou cole isto no seu agente de código:**

```text
Install the GoLive skill globally so I can use it across projects:
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global

Target the agent I'm using: add --agent codex --yes for Codex, or
--agent claude-code --yes for Claude Code. Keep --global.
If the agent isn't clear, ask me which one.

Verify the installation with:
node <installed-skill-dir>/scripts/golive.mjs version --json
Tell me if I need to reload skills or start a new session.
Stop after installation; don't connect accounts or deploy yet.
```

A instalação inclui as instruções, as referências de provedores e o runtime pré-compilado. Ela não
conecta contas nem faz o deploy de nada. Veja [instalação e atualizações](docs/DISTRIBUTION.md) para
as flags não interativas dos agentes, a verificação do runtime e o instalador próprio opcional.

### Instalação via npm

A mesma skill é publicada no npm como `golive@0.1.0-alpha.3` (dist-tags `alpha` e `latest`), o que a
instala offline, sem Git nem Skills CLI envolvidos:

```bash
# Codex
npx golive@alpha install --agent codex

# Claude Code
npx golive@alpha install --agent claude
```

Acrescente `--global` para instalar no seu diretório home (`~/.agents/skills/golive` ou
`~/.claude/skills/golive`) em vez do projeto atual; `--agent claude-code`, a grafia que o canal do
Skills CLI usa, também é aceito. O instalador copia a skill completa que o pacote traz, recusa um
destino que já existe e nunca conecta contas de provedor.

**Os dois canais trazem a mesma release.** O pacote npm publica a versão deste repositório, incluindo
os helpers do instalador autônomo, então uma instalação via npm é uma cópia sua, que se atualiza no
lugar. A snapshot anterior `0.1.0-alpha.0` não tem atualizador: remova aquela cópia e reinstale, ou
use o canal do GitHub, que gerencia as próprias instalações.
O pacote npm também expõe a CLI de terminal: os comandos do golive `npx golive@alpha help`,
`version`, `update-check`, `credentials`, `detect`, `menu`, `init`, `doctor`, `plan`, `teardown`,
`apply`, `verify`, `status` e `handoff` (o `apply` precisa do ID do plano aprovado e de confirmação
explícita), além dos comandos do instalador `install`, `install-status`, `update`, `rollback`,
`update-policy` e `recover-lock` para as cópias que ele mesmo mantém. Veja
[instalação e atualizações](docs/DISTRIBUTION.md#alternative-installation-the-npm-package) para os
limites exatos desse canal.

## Usar o GoLive

Abra o repositório do seu app no seu agente de código. Depois de instalar, recarregue as skills ou
inicie uma nova sessão se o GoLive não aparecer. O nome da skill é **`golive`**. Para a instalação
autônoma acima, digite uma destas opções **no chat do seu agente**:

| Agente | Exemplo de prompt |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills) | `$golive Help me take this app live.` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `/golive Help me take this app live.` |

Você também pode pedir em linguagem natural:

```text
Use the golive skill to take this app live. Keep the providers it already uses.
Show me the destination accounts and plan before changing anything.
```

O GoLive inspeciona o app, pergunta sobre os provedores que faltam e apresenta as contas de destino e
o plano para a sua aprovação antes de fazer qualquer alteração no provedor.

Esses são prompts de chat. `golive skill` não é um comando. Instalar via `npx skills add` não
adiciona um comando `golive` ao seu terminal; o agente executa a CLI incluída a partir do diretório da
skill instalada. O [pacote npm](README.md#install-from-npm) também instala a skill offline e expõe
essa CLI como `npx golive@alpha <command>`; os comandos de terminal dele rodam operações individuais,
não o fluxo conversacional da skill.

## Como é uma execução

Uma conversa ilustrativa para um app que já usa Supabase:

> **Você:** Use o golive para colocar este app em produção. Use recursos de teste por enquanto.
>
> **Agente:** Este app usa Supabase. Onde você quer hospedá-lo?
>
> 1. **Vercel** — fluxo de hospedagem nativo; testado ao vivo com o Supabase.
> 2. **Netlify** — fluxo de hospedagem nativo; a combinação testada ao vivo é Netlify + Neon.
> 3. **Outro** — me diga qual é o provedor; vou tentar uma configuração guiada com as ferramentas e a
>    documentação oficiais dele.
>
> **Você:** Vercel.
>
> **Agente:** Vamos manter o Supabase. Este app já tem um projeto Supabase, ou criamos um novo
> projeto de teste?
>
> **Você:** Crie um novo.
>
> **Agente:** Rode `vercel login` e `supabase login` numa janela de terminal separada.
> Quando você terminar, eu verifico qual conta e qual organização ficaram conectadas.
>
> **Você:** Pronto.
>
> **Agente:** Aqui está o plano: criar um novo projeto de frontend de teste no time da Vercel que
> você escolheu, criar o banco de dados dele na organização Supabase escolhida, transferir os valores
> de ambiente necessários e fazer o deploy. Vou mostrar os nomes e IDs reais dos destinos, as
> configurações dos recursos e as informações de custo junto com o plano. Aprove antes que eu aplique.
>
> **Você:** Aprovado.
>
> **Agente:** O deployment está no ar. Aqui estão a URL, o relatório de verificação e tudo o que
> ainda não foi verificado. Na sequência, vamos testar os fluxos de cadastro e de dados do próprio
> app. Quando você terminar com este projeto de teste, o `golive teardown` planeja a remoção dele
> para a sua aprovação antes que qualquer coisa seja excluída.

O GoLive mantém as escolhas de provedor que o seu app já faz e pergunta sobre as peças que faltam.
Você cuida dos cadastros, dos logins no navegador, das verificações de identidade e das compras. No
macOS, se uma API key for necessária, uma janela nativa de entrada oculta explica por que está pedindo
e onde a chave será salva. O valor dela vai direto para o arquivo local de credenciais, nunca para o
chat ou para a saída de comandos. Em outras plataformas, o seu próprio editor serve de alternativa.
Uma mudança posterior no plano exige outra aprovação; conectar autenticação ou um domínio pode exigir
um passo extra depois do primeiro deploy.

**Usando outro provedor?** A skill tem um fluxo guiado genérico: verificar a CLI oficial do provedor,
uma integração MCP oficial disponível ou a API, e então guiar você pelo dashboard dele se for preciso.
O agente continua mostrando o destino, as mudanças e o custo antes de pedir aprovação, e verifica o
que consegue depois. Isso é **orientação no melhor esforço possível**, sem garantia de conclusão nem
a mesma cobertura de verificação de um adaptador nativo. Se um passo não puder ser concluído ou
verificado, você recebe o bloqueio específico e a próxima ação. Veja
[escopo de provedores guiados](docs/PROVIDERS.md#guided-providers).

## O que este alpha suporta

**Duas opções de hospedagem: Vercel e Netlify. Duas opções de banco de dados: Supabase e Neon.**

| Caminho testado ao vivo | O que foi exercitado |
| --- | --- |
| **Vercel + Supabase** | Provisionamento, conexão das variáveis de ambiente, deploy, CRUD autenticado e isolamento de acesso |
| **Netlify + Neon** | Provisionamento, conexão das variáveis de ambiente, deploy, conectividade com o Postgres, checagens de API em duas sessões e CRUD pelo navegador |
| **Vercel + Porkbun (domínio próprio)** | Anexação do domínio, uma escrita aprovada de registro DNS sob `--confirm-dns`, verificação de propriedade e serviço HTTPS num subdomínio descartável |
| **Vercel + GoDaddy (domínio próprio)** | A mesma jornada num segundo subdomínio, incluindo o desafio TXT de propriedade que a Vercel pediu depois da anexação |
| **Vercel + Resend (e-mail)** | Configuração do domínio de envio, registros de DNS, verificação do domínio e um envio real usando a chave de ambiente do próprio app (entregue; o subdomínio novo caiu no spam) |
| **Vercel + Stripe (pagamentos de teste)** | Chaves em modo de teste e registro do webhook, a rejeição de uma requisição sem assinatura, e um pagamento real com cartão de teste entregue como evento com assinatura verificada |
| **Supabase Auth (SMTP + recuperação de senha)** | A escrita do SMTP personalizado relida junto com o limite de e-mails de autenticação elevado, e toda a rotação de recuperação na conta de teste semeada — pedido aceito, resposta idêntica para um endereço desconhecido, token já usado recusado na repetição, a nova senha entrando e a antiga recusada |

Foram execuções descartáveis aprovadas em contas já existentes; os recursos de teste concluídos foram
excluídos depois, e os projetos e registros descartáveis das execuções recentes são limpos sob a mesma
supervisão. Combinações cruzadas têm cobertura por mocks, não prova ao vivo equivalente. O reúso do
login da CLI do Supabase passou separadamente por verificação somente leitura; o teste de deployment
completo usou um token explícito. A configuração da primeira conta de um usuário novo e qualquer
framework de aplicação não foram validados.

Os comandos de ciclo de vida têm evidência própria: o `golive teardown` foi exercitado ao vivo num
projeto Netlify descartável (bloqueado sem `--confirm-destroy`, depois removido, com a lista de sites
da conta inalterada a não ser por ele) e execuções anteriores removeram os registros GoDaddy e
Porkbun que o golive havia escrito, revogaram as chaves de envio da Resend que ele havia emitido e
removeram o endpoint em modo de teste da Stripe que ele havia registrado. O `golive status` rodou em
modo somente leitura contra um projeto ao vivo; o `golive handoff --write` rodou num fixture
descartável só com Vercel: os dois artefatos foram escritos e auditados (uma etiqueta de proveniência
em cada linha de afirmação, a prova de propriedade e o portão de teardown nomeados, nenhum valor com
formato de credencial no documento, no seu gêmeo JSON, no estado ou na configuração), e o projeto foi
removido depois pelo fluxo de teardown aprovado — a stack era só de host, então as linhas de outros
provedores no documento continuam cobertas por mocks. Veja
[validação observada](docs/VALIDATION.md) para as evidências.

Também existem adaptadores experimentais para a configuração do Supabase Auth, para a jornada de
cadastro do Supabase Auth, para a recuperação de senha e o isolamento de contas dele, e para o DNS da
Cloudflare. As configurações do Supabase Auth — cadastro, confirmação de e-mail, tamanho mínimo de
senha, o mailer usado, além da URL do site e da allowlist de redirecionamento — são automatizadas por
meio de um plano aprovado e relidas como evidência, e esse caminho passou por uma execução ao vivo
descartável: a escrita da política se manteve na releitura (`password minimum length: 6 → 12`) e o
`auth-policy` terminou com o aviso sobre o mailer nativo como sua única constatação. A jornada de
cadastro opcional (`auth.e2e`) passou na mesma execução: um passo aprovado semeou uma conta de teste
real (`auth:test-user`, exige `--confirm-live`), o endereço não conseguiu entrar antes da confirmação
(`email_not_confirmed`), e as checagens `auth-signup`/`auth-session` provaram o e-mail de cadastro, a
confirmação obrigatória, o login confirmado, o token de sessão e a recusa a chamadas anônimas. Restam
dois limites: a confirmação foi aplicada pela API de admin do Auth, e não pelo clique no e-mail da
própria conta semeada, e a entrega na caixa de entrada é confirmada por uma pessoa, por design — o
golive nunca vê a caixa de entrada. Uma execução aprovada posterior, num fixture descartável (um site
Vercel implantado cuja rota declarada responde 401 sem sessão, mais uma tabela protegida por RLS),
exercitou as duas pontas do lado do app: um GET anônimo em `auth.protectedPath` respondeu 401 e a
sondagem autenticada leu aquela tabela como o usuário autenticado, de modo que a correção do bearer na
sondagem deixou de ser apenas coberta por mocks. O que essa evidência não consegue mostrar: a linha de
tabela daquela execução é uma contagem, e não nomes de tabelas, e qualquer 401 contou como proteção —
uma página de WAF ou de manutenção seria lida do mesmo jeito; as duas coisas foram corrigidas depois
(issue #30: a sondagem nomeia as tabelas que leu, e um caminho protegido recusado é corroborado
contra a raiz pública, com cobertura por mocks e sem nova execução ao vivo até agora). A recuperação
de senha é **validada ao vivo no mesmo provedor**: a mesma execução de 2026-09-24 trouxe
`auth.smtp: resend` (a escrita do SMTP personalizado e o limite de e-mails de autenticação elevado,
ambos relidos) e `auth.recovery: true`, cujo único passo aprovado (`auth:recovery`, exige
`--confirm-live`) rotacionou a senha daquela conta de teste registrada usando as próprias chamadas de
recuperação do provedor — pedir o e-mail, gerar o link com a API de admin, trocá-lo por uma sessão,
definir a nova senha com essa sessão — e a checagem `auth-recovery` passou em todas as etapas: o
pedido foi aceito, um endereço sem conta recebeu a mesma resposta (nenhuma enumeração de contas), o
token já usado foi recusado na repetição, a nova senha entrou e a que ela substituiu não. O clique na
caixa de entrada e qualquer captcha continuam com a pessoa (é o que diz o handoff
`auth:recovery-email`), a senha de SMTP é somente escrita (o provedor responde com um hash, então a
releitura prova as configurações, não uma entrega), e a conta foi confirmada pela API de admin do
Auth, e não pelo clique do dono. O isolamento de contas também está implementado no mesmo provedor:
`auth.isolation: true` com `auth.identityPath` e `auth.isolationPath` acrescenta um passo aprovado
(`auth:isolation`, exige `--confirm-live`) que semeia uma **segunda** conta de teste real — o endereço
derivado de `auth.testEmail`, a senha de novo apenas na memória daquela execução — e a confirma pela
API de admin do provedor (sem um segundo clique na caixa de entrada: a jornada é sobre os dados do
app, não sobre entrega). A checagem `auth-isolation` então entra como as duas contas e lê as duas
rotas declaradas do próprio app na URL de produção: ambas precisam recusar um chamador anônimo (um
200 é uma constatação crítica), a rota de identidade de cada conta precisa responder com o seu próprio
id de usuário e nunca com o da outra, e a rota de linhas precisa devolver apenas as linhas do próprio
chamador — verificado com uma linha marcadora única por conta, escrita **por essa rota** com a sessão
da conta e relida, de modo que o marcador de outra conta na resposta é uma leitura entre contas e
falha criticamente. Quando as rotas não são declaradas, o handoff não bloqueante
`auth:isolation-routes` transfere a tarefa de código do app; um 404 ou uma sessão recusada resulta em
skip com essa tarefa nomeada, nunca como aprovação. O isolamento de contas está **implementado e
coberto por mocks, ainda sem validação ao vivo** — a execução ao vivo dele vem em separado. A saída da
própria execução de recuperação continha dois defeitos, ambos corrigidos aqui com regressões em mocks:
o `teardown` reportava o domínio de envio *adotado* pelo dono como criado pelo golive (uma lista vazia
de marcadores de criação fazia `[].every()` ser verdadeiro, então todo domínio registrado era lido
como sendo do golive), e o handoff `auth:recovery-email` mostrava um skip de `verify` isolado como sua
evidência enquanto o estado registrava aquele passo como concluído. Sua terceira constatação — a
Resend continuava reportando aquele domínio como verificado enquanto os registros que ela listava não
existiam no nameserver autoritativo da zona — está corrigida pela
[#52](https://github.com/mikehasa/golive-skill/issues/52): o `email-verified` agora resolve os
registros que o próprio provedor lista para o domínio antes de passar (um domínio verificado cujos
registros sumiram falha, um registro que o golive escreveu dentro da janela de propagação só gera
aviso, e um provedor que não consegue listá-los resulta em skip em vez de aprovação), e o plano de
e-mail mantém o passo ou o handoff `email:dns` para registros que não resolvem, de modo que uma flag
desatualizada já não consegue escondê-los. Coberto por mocks; não foi reexercitado ao vivo. Os
caminhos de DNS, e-mail e pagamento em modo de teste listados acima são os testados, com as execuções
de domínio próprio usando escritas de registro na Porkbun e na GoDaddy; **o DNS da Cloudflare
especificamente ainda não é um caminho validado deste alpha**, e os outros provedores de autenticação
continuam guiados. Veja [escopo de provedores](docs/PROVIDERS.md) e
[validação observada](docs/VALIDATION.md).

## A checklist completa de go-live e o roadmap

Uma URL funcionando é só o começo. Dependendo do app, entrar em produção pode significar tudo o que
vem a seguir. **O GoLive deve descobrir quais itens se aplicam, ajudar você a concluí-los e mostrar
evidência do resultado.** Não se deve pedir a um site estático que configure um banco de dados; um
SaaS pago não deve parar numa homepage publicada.

Este é o nosso roadmap de produto na forma de checklist de lançamento. Os checkmarks e riscos marcam
**marcos específicos testados ao vivo**, não uma categoria concluída nem uma checklist pronta para o
seu app.

**✅ Testado ao vivo** · **🚧 Em andamento / experimental** (o código existe; a jornada completa está
pendente) · **🗺️ Planejado**

### Colocar o app no ar

- [x] ✅ **Hospedagem de frontend:** ~~Provar o deploy na Vercel e na Netlify.~~ Construir, publicar e
  verificar o projeto pretendido nos dois caminhos testados.
- [x] ✅ **Banco de dados:** ~~Provar provisionamento e conexão com Supabase e Neon.~~ Os caminhos
  testados incluem a conexão das variáveis de ambiente e checagens de CRUD na aplicação.
- [x] ✅ **Variáveis de ambiente:** ~~Conectar as credenciais de hospedagem e de banco nos dois
  caminhos testados.~~ Rotação de segredos mais ampla e gestão do ciclo de vida dos ambientes seguem
  planejadas.
- [ ] 🗺️ **Backend / servidores:** serviços de API dedicados, contêineres, servidores persistentes,
  configuração de runtime e health checks. As rotas do app já são publicadas pelos hosts suportados.
- [ ] 🗺️ **Schema e dados:** migrações revisadas, rollout seguro, separação de ambientes e checagens
  de dados do app. Esses pontos foram supervisionados separadamente em testes ao vivo; um fluxo
  reutilizável ainda está planejado.
- [ ] 🗺️ **Armazenamento de arquivos e objetos:** buckets, uploads, regras de acesso, URLs assinadas e
  políticas de ciclo de vida.

### Transformar em um produto completo

- [ ] 🚧 **Autenticação:** cadastro, login, sessões, recuperação de senha e isolamento de contas.
  A política de autenticação do Supabase (cadastro, confirmação de e-mail, tamanho mínimo de senha,
  mailer) e a URL do site/allowlist de redirecionamento são escritas por meio de um plano aprovado,
  relidas como evidência e verificadas pelas checagens `auth-policy`/`auth-redirects` — exercitadas
  numa execução descartável aprovada, em que a escrita da política se manteve num mínimo de doze
  caracteres. A jornada opcional (`auth.e2e: true`) passou na mesma execução: o passo `auth:test-user`
  semeou uma conta de teste real, aquele endereço não conseguiu entrar antes da confirmação, e as
  checagens `auth-signup`/`auth-session` provaram o e-mail de cadastro, a confirmação obrigatória, o
  login confirmado e o token de sessão — **validado ao vivo para o Supabase em projetos descartáveis,
  em que a confirmação veio pela API de admin do Auth em vez do clique no e-mail semeado, a entrega na
  caixa de entrada continuou confirmada por uma pessoa, e uma execução posterior provou um caminho
  protegido declarado (um 401 anônimo) e uma leitura autenticada de uma tabela protegida por RLS,
  reportada como contagem em vez de nome de tabela**. A recuperação de senha é **validada ao vivo no
  mesmo provedor** (`auth.recovery: true` acrescenta o passo `auth:recovery` e a checagem
  `auth-recovery`, que provaram ausência de enumeração de contas, um token de uso único e a troca de
  senha num projeto descartável; a confirmação veio pela API de admin do Auth, o clique na caixa de
  entrada continua confirmado por uma pessoa, e dois defeitos de saída que aquela execução encontrou —
  uma falsa alegação de propriedade “criado pelo golive” e um texto de evidência de handoff que
  contradizia o passo registrado — estão corrigidos com regressões em mocks). O isolamento de contas —
  a outra metade, e justamente a que execuções anteriores não conseguiram exercitar — está
  implementado e coberto por mocks da mesma forma: `auth.isolation: true` com `auth.identityPath` e
  `auth.isolationPath` acrescenta o passo `auth:isolation` (uma segunda conta de teste real,
  confirmada pela API de admin do provedor e registrada por id e endereço) e a checagem
  `auth-isolation`, que entra como as duas contas e prova, nas rotas do próprio app, que nenhuma
  consegue ler a identidade ou as linhas da outra (uma leitura entre contas falha criticamente; uma
  rota não declarada ou 404 resulta em skip com a tarefa de código do app). A execução ao vivo dela
  também vem em separado. Os outros provedores de autenticação continuam guiados.
- [ ] 🗺️ **OAuth / login social / SSO:** registro do cliente, telas de consentimento, escopos, URLs de
  callback e revisões do provedor. A configuração atual de provedores de autenticação é guiada.
- [x] ✅ **Pagamentos e assinaturas:** ~~Provar checkout em modo de teste e aceitação de webhook com a
  Stripe.~~ Um pagamento real com cartão de teste entregou um evento `checkout.session.completed` com
  assinatura verificada. Prontidão para o modo live, direitos de acesso (entitlements), reembolsos e
  eventos de assinatura ainda precisam de validação.
- [x] ✅ **E-mail transacional:** ~~Provar configuração do domínio de envio, verificação e entrega real
  com a Resend.~~ Um envio pela chave de ambiente do próprio app foi entregue (foi para o spam num
  subdomínio novo, sem DMARC ainda). Com `auth.smtp: resend`, o passo `auth:smtp` também escreve o
  SMTP personalizado do projeto de autenticação — host/porta/usuário da Resend, o remetente que o app
  já usa e uma senha de SMTP tirada de uma chave de envio que o golive emitiu (a chave da jornada de
  e-mail, ou uma que ele emite só para o SMTP) — e eleva o limite de e-mails de autenticação do próprio
  projeto (`rate_limit_email_sent`) para 30 por hora (ou `auth.emailRateLimitPerHour`) na mesma
  escrita, porque o provedor mantém esse limite junto com o SMTP personalizado. O `auth-policy` então
  reporta `custom SMTP via Resend` em vez de avisar sobre o mailer nativo. A senha é somente escrita (o
  provedor responde com um hash), então a releitura confirma as configurações e um e-mail de
  autenticação real é a única prova completa. **Validado ao vivo num projeto descartável
  (2026-09-24)**: a mesma execução escreveu o SMTP personalizado e o releu (`smtp.resend.com`, porta
  465, usuário `resend`, remetente `auth@mail.trytofu.xyz`) junto com
  `auth email rate limit: 2 → 30 per hour`, emitiu a chave de SMTP sozinha e a revogou no teardown, e
  o `auth-policy` então leu `custom SMTP via Resend` com 30 e-mails de autenticação por hora — só
  configurações e limite de taxa, já que a senha em si nunca pode ser relida. Tratamento de bounce,
  conteúdo de mensagem mais
  rico e entrega real na caixa de entrada (confirmada por uma pessoa, por design, e duvidosa no domínio
  daquela execução — veja a
  [issue #52](https://github.com/mikehasa/golive-skill/issues/52)) ainda precisam de validação.
- [x] ✅ **Domínios / DNS / HTTPS:** ~~Provar anexação de domínio, ligação de DNS e serviço HTTPS em
  pares host+DNS.~~ Testado: anexação na Vercel com escritas de registro na Porkbun e na GoDaddy sob
  `--confirm-dns`, verificação de propriedade e HTTPS 200 em subdomínios descartáveis. O adaptador de
  DNS da Cloudflare, os redirecionamentos e outros pares de host ainda precisam de validação ao vivo.
- [ ] 🗺️ **SMS e notificações push:** registro de remetente, credenciais, permissões e checagens de
  entrega.
- [ ] 🗺️ **Serviços de terceiros e de IA:** acesso à API, escopos, callbacks, cotas e testes
  funcionais. Variáveis de ambiente ausentes já são detectadas hoje; fluxos específicos por serviço
  estão planejados.
- [ ] 🗺️ **Processamento em segundo plano:** agendamentos cron, filas, workers, retentativas e
  recuperação de jobs que falharam.
- [ ] 🗺️ **Cache, busca e tempo real:** caches, índices de busca/vetoriais e serviços de tempo real
  quando forem necessários.

### Lançar com confiança e manter tudo rodando

- [ ] 🗺️ **Segurança e controles contra abuso:** políticas de acesso, credenciais expostas, cabeçalhos
  de segurança, limites de requisição e proteção contra bots. Hoje existem checagens pontuais de
  RLS/advisor e de padrões de credencial.
- [ ] 🗺️ **Monitoramento e alertas:** rastreamento de erros, logs, uptime e alertas acionáveis.
  Sugestões de provedores são guiadas hoje; uma configuração verificada está planejada. Checagens de
  drift sob demanda existem (`golive status`, abaixo) — monitoramento contínuo e alertas, não.
- [ ] 🗺️ **Analytics de produto:** validação de eventos e configurações de consentimento/dados, além
  das sugestões guiadas de provedores que existem hoje.
- [ ] 🚧 **CI/CD e releases seguros:** previews, checagens de release, promoção, rollback e detecção
  de drift, com base nos deploys por CLI aprovados que já existem hoje. **Identidade de deployment —
  implementada, sem validação ao vivo:** cada deploy bem-sucedido registra a identidade que o próprio
  provedor dá ao deployment que fez (`deployed:<target>:id` = `<provider>|<deployment id>|<url>|<time>`
  em `.golive/state.json`, coberto por mocks; um provedor que não reporta identidade não registra
  nenhuma), para que uma capacidade futura possa nomear um deployment exato. **Deploy de preview
  opcional e checagem de release — implementados, sem validação ao vivo:** com `release.preview: true`
  em `golive.yaml` (e `preview` em `targets`), o `plan` acrescenta `preview:deploy` — um create que
  publica a árvore de trabalho atual no alvo de preview do host, nomeia o provedor, o projeto, o alvo
  de ambiente e o projeto de origem que o preview compartilha com a produção, exige `--confirm-live`
  quando um valor de modo live preenche um nome de ambiente de preview, e registra a identidade do
  próprio provedor como `deployed:preview:id` — e `release:check`, que não escreve nada, declara
  `preview:deploy` como seu pré-requisito e reprova o plano quando a leitura que o provedor faz desse
  deployment ou uma varredura de credenciais no bundle dele falha. Num plano que constrói um candidato
  a release, essa checagem é o último passo, então o que ela protege é a promoção (cujo próprio plano
  roda a checagem de novo antes de mexer na produção), não o deploy de produção que o mesmo plano já
  emitiu antes dela. **Promoção e
  rollback — implementados, sem validação ao vivo:** com `release.promote: true` (além do opt-in de
  preview) um plano pede uma release por promoção, e com `release.rollback: true` ele pede reapontar a
  produção para um deployment anterior que o próprio golive criou e registrou. O `promote:production`
  nomeia o id exato do deployment que ele tornaria produção — o provedor só reporta o id de um
  deployment depois que ele existe, então construir o candidato e promovê-lo são dois planos, e o
  plano que você aprova diz qual deles é — é protegido pelo `release:check` relendo esse deployment no
  mesmo plano, e **não
  precisa de nenhuma flag extra de confirmação**: o id do plano, o deployment nomeado e o portão
  recém-executado são a aprovação. Os dois passos releem o deployment alvo e o que a produção serve
  antes de escrever, e provam o que a produção serve depois; os dois mantêm a parada entre releases
  (nenhum deles é `replayable` nem uma exclusão), e nenhum é automático — nenhuma checagem que falha
  dispara rollback, e um deployment criado por um dashboard, por um push no Git ou por um pull request
  nunca é alvo de promoção ou rollback (é um handoff, nomeado como tal). O que cada host suporta é
  diferente, e o golive recusa em vez de adivinhar: a Netlify relê o deployment que publicou e
  consegue restaurar um anterior, então os dois passos funcionam lá; a Vercel não expõe nenhuma leitura
  do que a produção serve nem nenhuma chamada de promoção/rollback que o golive tenha exercitado,
  então na Vercel nada é promovido ou revertido e um aviso explica por quê. O `production-release`
  prova o que a produção serve, nomeia o que ela servia antes e reporta como handoff um deployment que
  o golive nunca registrou. Acrescentar esses step ids muda o id de um plano, então uma aprovação que
  não foi aplicada precisa ser replanejada. As checagens de preview (e, portanto, a promoção) resultam
  em skip num host que não expõe leitura por deployment (Vercel), reportando isso em vez de adivinhar.
  A detecção de drift existe como o comando somente leitura `golive status` descrito abaixo (ele rodou
  em modo somente leitura na validação de autenticação e não tinha nada acionável depois que aquela
  jornada passou, mas as linhas de base de DNS, ambiente, webhook e deployment que ele compara ainda
  carecem de evidência ao vivo), e deployments de preview ainda não estão entre os assuntos que ele
  compara.
- [ ] 🗺️ **Backups e recuperação:** retenção, simulações de restauração, passos de incidente e limpeza
  aprovada. O `teardown` aprovado remove o que o golive criou; backups e qualquer restauração continuam
  trabalho manual e supervisionado.
- [x] ✅ **Desinstalação / teardown:** ~~um inventário aprovado dos recursos criados pelo golive e a
  remoção deles.~~ O `golive teardown` planeja a remoção, exclui apenas o que o golive pode provar que
  criou (provas de propriedade e `--confirm-destroy`) e relê, depois de excluir, a lista de registros
  de propriedade do golive na zona de DNS e a leitura do próprio projeto no host. Nada que ele não
  consiga remover é descartado em silêncio: uma sobra — uma zona ilegível, um projeto de host que não
  pode ser removido, um provedor que não está logado — vira um handoff que nomeia o que resta e a
  correção exata, e projetos Supabase/Neon e o domínio de envio da Resend continuam handoffs manuais
  ([#9](https://github.com/mikehasa/golive-skill/issues/9)). Uma remoção esquece a linha de base que o
  golive registrou para aquele recurso, então o `golive status` não reporta o teardown do próprio
  golive como drift, e uma chave de envio revogada pelo golive é reportada como aviso em vez de
  aprovação, porque o provedor não oferece nenhuma leitura para confirmar isso.
- [ ] 🗺️ **Custos e cotas:** escolha de planos, orçamentos, alertas e checagens de capacidade. Hoje
  existem guardas pontuais para planos gratuitos; a gestão contínua de custos está planejada.
- [ ] 🗺️ **Essenciais de lançamento:** metadados, previews de compartilhamento, indexação,
  acessibilidade, links de suporte e páginas de política revisadas pelo dono.
- [ ] 🚧 **Propriedade e handover:** contas, recursos, acessos, responsabilidades de renovação e
  instruções de manutenção. O `golive handoff --write` registra a rota de login, as provas de
  propriedade, os jobs recorrentes e os portões de remoção em `GOLIVE_HANDOVER.md`, marcando cada linha
  como verificada, registrada, não verificável ou desconhecida, e o `golive status` relê esses
  assuntos sob demanda: ele compara as linhas de base que o golive registrou com os provedores como
  estão agora e nomeia o que não conseguiu ler. Rebasear o drift continua manual e aprovado — o comando
  está implementado e rodou em modo somente leitura na validação de autenticação, mas uma validação ao
  vivo de todos os assuntos de drift ainda está pendente.

Alguns passos sempre vão precisar de uma pessoa: aceitar termos, verificação de identidade, compras,
escolhas de cobrança e as revisões que um provedor exige. “Guiado” ainda deve significar uma próxima
ação clara, a página certa, as permissões certas, uma checagem depois e o retorno ao mesmo fluxo.
Quando o próprio app precisa de mudanças de código, o GoLive deve dar ao agente de código uma tarefa
concreta e rechecar o resultado. Ele não deve fazer você coordenar uma dúzia de conversas de
configuração desconectadas.

**Próximos passos:** concluir e testar ao vivo as jornadas de lançamento restantes — a execução ao vivo
do isolamento de contas (implementado e coberto por mocks no Supabase, ainda não exercitado contra um
projeto real), os fluxos de pagamento em modo live e o adaptador de DNS da Cloudflare — e depois
ampliar as arquiteturas de app suportadas e as operações contínuas.

Estas são direções, não datas de lançamento. Uma capacidade só deve sair do estágio experimental
depois que a configuração de conta, a conexão, a verificação e a recuperação dela tiverem sido
exercitadas. Contribuições para qualquer parte desta checklist são bem-vindas, especialmente
evidências de onde um lançamento real trava.

<details>
<summary>Checklists de produção que inspiraram este roadmap</summary>

O escopo se baseia na [checklist de lançamento da Vercel](https://vercel.com/docs/production-checklist),
na [checklist de produção do Supabase](https://supabase.com/docs/guides/deployment/going-into-prod),
na [checklist de go-live da Stripe](https://docs.stripe.com/get-started/checklist/go-live), nas
[orientações de produção do OAuth do Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
e nas [orientações de produção do Next.js](https://nextjs.org/docs/pages/guides/production-checklist).
Elas informam os objetivos acima; não são funcionalidades do GoLive nem requisitos obrigatórios para
todo app.

</details>

## Verificação que você pode inspecionar

O relatório registra resultados de **aprovado (pass), reprovado (fail), aviso (warning) e ignorado
(skipped)**, junto com os passos humanos que ainda restam. As checagens incluem acesso à conta, nomes
de variáveis de ambiente, URLs de deployment confirmadas pelo provedor, padrões de segredo em
JavaScript público, acesso ao banco de dados, configurações suportadas de autenticação/webhook/DNS e
(onde o host consegue responder) o deployment que o provedor diz que a produção serve.

Um deployment pronto não é prova de que o app funciona. Um nome de variável de ambiente pode existir
com o valor errado. Um domínio de e-mail verificado não prova entrega na caixa de entrada. Eventos de
pagamento assinados, cadastro e os fluxos de negócio do app precisam de testes funcionais.
**Ignorado não é aprovado.**

O seu app ganha `golive.yaml`, `.golive/state.json`, `.golive/report.json` e `GOLIVE_REPORT.md`.
O estado preserva IDs de recursos e evidências de passos para a recuperação; ele não é um cofre de
credenciais. O `golive teardown` remove o que o golive criou depois da própria aprovação e de
`--confirm-destroy`; não existe rollback entre provedores, restauração nem um comando geral de
reconciliação para esses recursos — o `release:rollback` (opcional) apenas reaponta a produção para um
deployment anterior que o próprio golive registrou, e não toca em nenhum recurso de dados, DNS,
pagamento ou e-mail.

O `golive handoff --write` acrescenta o documento de propriedade: `GOLIVE_HANDOVER.md` na raiz do
repositório e sua origem JSON em `.golive/handover.json`. Ele nomeia as contas e a rota de login, cada
recurso que o golive criou e a prova de que ele é do golive, o que ainda é manual, o que se repete,
como funciona a remoção e quais comandos rechecam cada assunto. Cada linha diz se aquilo foi
verificado naquela execução, registrado antes, não verificável pelo golive ou desconhecido; o golive
não leu nenhum dado de cobrança, então nenhum valor de custo é declarado. Os arquivos não contêm
valores de segredo, mas metadados sem segredo ainda podem identificar recursos privados — revise-os
antes de compartilhar. O `--write` nunca sobrescreve um arquivo que o golive não gerou, a menos que
`--force` seja passado.

O `golive status` faz a pergunta seguinte: alguma coisa mudou pelas costas do golive desde que ele
registrou o que fez? Ele compara linhas de base registradas — os registros de DNS que o golive
escreveu, os **nomes** de variáveis de ambiente que ele entregou, o endpoint de webhook registrado, a
anexação do domínio, o projeto de banco de dados e seus seletores de conexão, o domínio de envio, a
conta de pagamento por trás das chaves do app, o projeto no host — com leituras feitas agora, e rotula
os dois lados: `expected (recorded by golive <time>)` contra `observed (read now)`. Cada item diz quem
pode agir: rodar uma checagem de novo, replanejar e aplicar uma mudança aprovada, ou uma decisão que só
uma pessoa pode tomar. É somente leitura: nenhum arquivo de relatório, nenhuma escrita no provedor,
nenhuma mudança de estado, e ele sai com `2` quando há algo a tratar. Um provedor que ele não consegue
ler é reportado como não verificável — nunca como limpo e nunca como falha — e ele nunca rebaseia nada
sozinho. O drift deliberadamente não é um portão: `plan`, `apply` e `verify` nunca o consultam.
O `status` está **implementado**, e rodou em modo somente leitura durante a validação de autenticação
do Supabase (um passo que falhou apareceu como acionável e, depois que ele passou, a lista ficou
vazia), mas uma validação ao vivo dos assuntos de drift restantes ainda está pendente.

## Credenciais e controle

- **Aprovar antes de mexer nas contas.** Os planos nomeiam os destinos e as escritas pretendidas, e o
  `apply` recusa sem o id do plano aprovado e sem `--yes`. Mudar a release instalada invalida
  aprovações antigas. Passos de DNS, de pagamento real e de exclusão têm portões extras
  (`--confirm-dns`, `--confirm-live`, `--confirm-destroy`), e o primeiro deploy de produção de um
  projeto também exige `--confirm-live`, porque antes bastava aprovar um plano para escrever em
  produção pela primeira vez.
  [Confiança, acesso e controle](docs/TRUST.md#what-golive-may-write-and-what-comes-first) percorre
  cada portão.
- **Mantenha os segredos fora do chat.** Logins de fornecedores suportados são reaproveitados. No
  macOS, uma janela nativa de entrada oculta pode salvar uma API key necessária; o seu próprio editor é
  a alternativa. As chaves ficam em `~/.config/golive/credentials`, um arquivo local em texto puro com
  modo 0600, fora do repositório do seu app — não é um keychain do sistema, então qualquer coisa
  rodando como o seu usuário consegue lê-lo. O código de execução mantém os valores fora de argv,
  planos, estado, relatórios e da saída de comandos, guardando impressões digitais (fingerprints) em
  vez dos valores. `golive credentials --remove NAME --yes` apaga uma entrada guardada, de forma
  irreversível; revogar o token no provedor é o que de fato encerra o acesso. Senhas de login do Mac
  continuam com os prompts de autenticação do macOS e dos fornecedores; o GoLive nunca pede que você
  digite uma delas na sua janela de chaves. A fronteira completa está em
  [confiança, acesso e controle](docs/TRUST.md#the-credential-boundary).
- **As atualizações têm dono.** O Skills CLI gerencia as próprias instalações. O instalador próprio
  opcional suporta atualizações do pacote completo e rollback local; a substituição automática fica
  desligada por padrão. Atualize entre execuções de deploy, nunca entre um plano e o seu apply.
  Recursos na nuvem não são afetados pelo rollback.
- **As suas contas continuam suas.** O GoLive não compra serviços nem cria contas de cobrança.
  Seu agente de código, os provedores e o instalador têm as próprias práticas de dados.

## Contribuir

🤝 **Estamos no começo, e adoraríamos a sua ajuda para moldar o GoLive.** Relatos de bug, ideias de
funcionalidade, correções na documentação e pull requests são todos bem-vindos. Você não precisa
construir um adaptador para contribuir: uma instrução de login confusa ou um lançamento real que
travou também é feedback útil.

Abra uma issue para relatar um problema ou discutir uma ideia, ou mande um PR focado. Para uma adição
maior de provedor ou de fluxo de trabalho, considere abrir uma issue primeiro para combinarmos o
escopo juntos. Nunca inclua segredos nem respostas brutas de autenticação num relato.

Veja o **[CONTRIBUTING.md](CONTRIBUTING.md)** para configuração local, testes e a sua primeira
contribuição. A [arquitetura](docs/ARCHITECTURE.md), [confiança, acesso e controle](docs/TRUST.md),
[recuperação](docs/RECOVERY.md), [escopo de provedores](docs/PROVIDERS.md) e o
[registro de validação](docs/VALIDATION.md) explicam o que existe e onde a ajuda é necessária.

[Licenciado sob MIT](LICENSE). Os avisos de terceiros incluídos no pacote estão em
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
