<!-- golive-translation: lang=es; source=README.md; source-commit=0fc6dca; reviewed=false; updated=2026-09-26 -->
# GoLive

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

**Pon en producción el producto que construyó tu agente: hosting, base de datos, autenticación, dominio, correo y pagos, todo en tus propias cuentas. Después, entrégalo o desmóntalo por completo.**

Tu agente de programación puede construir una app en minutos. Llevarla a usuarios reales sigue
pasando por cuentas, hosting, bases de datos, dominios, secretos y servicios conectados. GoLive es el
Agent Skill de código abierto para ese trabajo: **detecta lo que tu app necesita, planifica los
cambios exactos, te pide aprobación, los aplica con tus propios inicios de sesión y verifica lo que
funciona de verdad** — y luego registra lo que creó, lo vuelve a comprobar en busca de deriva cuando
se lo pides y puede eliminarlo de nuevo.

Automatiza las partes que los proveedores exponen. Te guía en las que necesitan a una persona.
Verifica lo que se puede observar y deja claro lo que quedó sin terminar. Sin cuenta de GoLive, sin
backend alojado y sin telemetría del producto.

> **Alpha temprana · 0.1.0-alpha.4**
> Las pruebas desechables en vivo ya cubren seis recorridos: **hosting** (Vercel, Netlify),
> **base de datos** (Supabase, Neon), **DNS de dominio personalizado** (Porkbun, GoDaddy),
> **correo transaccional** (Resend), **pagos en modo de prueba** (Stripe) y **autenticación de
> Supabase**, además de la ruta de desinstalación `teardown`. El documento de propiedad y la
> comprobación de deriva bajo demanda `golive status` están implementados y cubiertos por tests
> (`golive status` también se ejecutó en modo lectura en una validación en vivo), mientras que la
> [hoja de ruta](README.md#the-full-go-live-checklist-and-roadmap) más amplia marca nuestra
> dirección, no la afirmación de que todo esté ya construido.

## Antes de entregar el acceso a producción

Decidir si le das tus cuentas de proveedor a un agente se reduce a cuatro preguntas. Estas son las
respuestas de este proyecto, con sus límites declarados allí donde existen.

- **Tú sigues aprobando cada escritura.** Nada llega a una cuenta real sin un plan que hayas visto y
  aprobado: `apply` se niega sin el id de ese plan y sin `--yes`, y vuelve a comprobar la identidad
  del plan antes de escribir, de modo que un cambio de release o de configuración invalida la
  aprobación anterior. Las escrituras de DNS necesitan `--confirm-dns`; los borrados,
  `--confirm-destroy`; y los pasos en modo live —pagos en live, datos de producción, una cuenta
  real— necesitan `--confirm-live`, que ahora incluye el **primer despliegue a producción** de un
  proyecto, porque antes bastaba con aprobar un plan para escribir en producción por primera vez.
  Los valores de las credenciales solo se leen dentro del proceso, nunca se imprimen y nunca
  aparecen en argumentos, planes, estado ni informes; el archivo donde golive los guarda está en
  texto plano con permisos 0600 fuera de tu repositorio, y no es un llavero del sistema. Un límite
  que conviene nombrar: esos indicadores son argumentos que el agente pasa en tu nombre, y un agente
  que ya tenga la sesión iniciada en tu proveedor puede escribir allí sin ningún plan de golive.
  [Confianza, acceso y control](docs/TRUST.md) separa lo que el código impone de lo que solo es una
  instrucción que se le pide seguir al agente.
- **Una ejecución se detiene en lugar de seguir adelante.** `apply` se para en la primera
  comprobación fallida, la primera confirmación que falte, el primer requisito previo ausente o el
  primer proveedor que contradiga el plan. Los pasos siguientes no se ejecutan, y el siguiente
  `apply` retoma en ese paso. [Recuperación](docs/RECOVERY.md#the-run-stopped) explica cómo leer el
  fallo, qué pasos se retoman y los casos que necesitan antes una decisión revisada.
- **La reversión es estrecha, opcional y nunca automática.** Una comprobación fallida nunca dispara
  una reversión. `release.rollback: true` planifica un único paso que vuelve a apuntar producción a
  un despliegue anterior que el propio golive registró; un despliegue creado desde un panel, un push
  de Git o un pull request no es un objetivo, y este paso no toca ningún recurso de datos, DNS,
  pagos ni correo. Hoy solo Netlify admite esa reorientación — en Vercel la producción se corrige en
  el panel (el adaptador de Vercel no lee lo que sirve producción). La promoción y la reversión
  están implementadas y cubiertas con mocks, **sin validar en vivo**.
- **Nada se queda atrás en silencio, lo cual no es lo mismo que no dejar nada atrás.**
  `golive teardown` elimina solo los recursos que puede demostrar que creó, vuelve a leer la zona DNS
  y el proyecto del host después de borrar, y nombra cada sobrante que no puede eliminar —proyectos
  de Supabase y Neon, el dominio de envío de Resend, una zona o un proyecto de host que no puede
  leer— como un handoff que dice qué queda y cómo quitarlo a mano. Además, una eliminación olvida la
  línea base que golive había registrado para ese recurso, así que `golive status` no informa del
  propio teardown de golive como deriva.

Esas respuestas completas están en [confianza, acceso y control](docs/TRUST.md) y
[recuperación](docs/RECOVERY.md). La [arquitectura](docs/ARCHITECTURE.md) es el contrato del
producto, el [alcance de proveedores](docs/PROVIDERS.md) dice qué puede hacer hoy cada uno, el
[registro de validación](docs/VALIDATION.md) separa lo que se ha ejercitado en vivo de lo que solo
está cubierto con mocks, y [distribución](docs/DISTRIBUTION.md) cubre la instalación y las
actualizaciones.

[Instalar](README.md#install) · [Usar GoLive](README.md#use-golive) · [Ver el flujo de trabajo](README.md#what-a-run-looks-like) · [Alcance de la alpha](README.md#what-this-alpha-supports) · [Hoja de ruta](README.md#the-full-go-live-checklist-and-roadmap) · [Contribuir](CONTRIBUTING.md)

## Instalación

Necesitas **Node.js 20+**, npm/npx, Git y un agente de programación capaz de cargar skills y
ejecutar comandos. La instalación se ha comprobado con Codex y Claude Code; los demás clientes no
están verificados.

**Instálalo una vez para todos tus proyectos.** Ejecuta esto desde cualquier directorio:

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

Selecciona tu agente cuando aparezca el aviso: las flechas para moverte, Espacio para seleccionar y
Enter para confirmar. Esa pantalla está esperando que introduzcas algo; la instalación continúa
después de que confirmes.

Para saltarte el selector de agentes, usa el comando de tu agente:

```bash
# Codex
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent codex --yes

# Claude Code
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent claude-code --yes
```

Para instalarlo solo en un proyecto, ejecútalo desde el repositorio de ese proyecto y omite
`--global`.

**O pega esto en tu agente de programación:**

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

La instalación incluye las instrucciones, las referencias de proveedores y el runtime precompilado.
No conecta cuentas ni despliega nada. Consulta [instalación y
actualizaciones](docs/DISTRIBUTION.md) para los indicadores no interactivos del agente, la
verificación del runtime y el instalador propio opcional.

### Instalar desde npm

El mismo skill está publicado en npm como `golive@0.1.0-alpha.4` (dist-tags `alpha` y `latest`), lo
que lo instala sin conexión, sin Git ni Skills CLI de por medio:

```bash
# Codex
npx golive@alpha install --agent codex

# Claude Code
npx golive@alpha install --agent claude
```

Añade `--global` para instalarlo en tu directorio personal (`~/.agents/skills/golive` o
`~/.claude/skills/golive`) en lugar de en el proyecto actual; también se acepta `--agent claude-code`,
la grafía que usa el canal de Skills CLI. El instalador copia el skill completo que incluye el
paquete, rechaza un destino que ya exista y nunca conecta cuentas de proveedores.

**Los dos canales distribuyen el mismo release.** El paquete de npm publica la versión de este
repositorio, incluidos los ayudantes del instalador independiente, así que una instalación desde npm
es una copia propia que se actualiza sobre el terreno. La instantánea anterior `0.1.0-alpha.0` no
tiene actualizador: elimina esa copia y vuelve a instalar, o usa el canal de GitHub, que gestiona sus
propias instalaciones.
El paquete de npm también expone la CLI de terminal: los comandos de golive `npx golive@alpha help`,
`version`, `update-check`, `credentials`, `detect`, `menu`, `init`, `doctor`, `plan`, `teardown`,
`apply`, `verify`, `status` y `handoff` (`apply` necesita el ID del plan aprobado y una confirmación
explícita), además de los comandos del instalador `install`, `install-status`, `update`, `rollback`,
`update-policy` y `recover-lock` para las copias que son suyas. Consulta [instalación y
actualizaciones](docs/DISTRIBUTION.md#alternative-installation-the-npm-package) para conocer los
límites exactos de este canal.

## Usar GoLive

Abre el repositorio de tu app en tu agente de programación. Después de instalarlo, recarga los skills
o inicia una sesión nueva si GoLive no aparece. El nombre del skill es **`golive`**. Con la
instalación independiente de arriba, escribe una de estas opciones **en el chat de tu agente**:

| Agente | Prompt de ejemplo |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills) | `$golive Help me take this app live.` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `/golive Help me take this app live.` |

También puedes pedirlo en lenguaje natural:

```text
Use the golive skill to take this app live. Keep the providers it already uses.
Show me the destination accounts and plan before changing anything.
```

GoLive inspecciona la app, pregunta por los proveedores que faltan y te presenta las cuentas de
destino y el plan para que los apruebes antes de hacer ningún cambio en los proveedores.

Estos son prompts de chat. `golive skill` no es un comando. Instalar con `npx skills add` no añade un
comando `golive` a tu terminal; el agente ejecuta la CLI incluida desde el directorio del skill
instalado. El [paquete de npm](README.md#install-from-npm) también puede instalar el skill sin
conexión y expone esa CLI como `npx golive@alpha <command>`; sus comandos de terminal ejecutan
operaciones sueltas, no el flujo conversacional del skill.

## Cómo es una ejecución

Una conversación ilustrativa con una app que ya usa Supabase:

> **Tú:** Usa golive para llevar esta app a producción. De momento, usa recursos de prueba.
>
> **Agente:** Esta app usa Supabase. ¿Dónde te gustaría alojarla?
>
> 1. **Vercel** — flujo de hosting integrado; probado en vivo con Supabase.
> 2. **Netlify** — flujo de hosting integrado; la pareja probada en vivo es Netlify + Neon.
> 3. **Otro** — dime cuál es tu proveedor; intentaré una configuración guiada con sus herramientas y
>    su documentación oficiales.
>
> **Tú:** Vercel.
>
> **Agente:** Mantendremos Supabase. ¿Esta app ya tiene un proyecto de Supabase o creamos uno nuevo
> de prueba?
>
> **Tú:** Crea uno nuevo.
>
> **Agente:** Ejecuta `vercel login` y `supabase login` en otra ventana de terminal. Cuando
> termines, comprobaré qué cuenta y qué organización están conectadas.
>
> **Tú:** Hecho.
>
> **Agente:** Este es el plan: crear un proyecto de frontend de prueba nuevo en tu equipo de Vercel,
> crear su base de datos en tu organización de Supabase, transferir los valores de entorno
> necesarios y desplegar. Te mostraré los nombres e ids reales de los destinos, la configuración de
> los recursos y la información de coste junto con el plan. Apruébalo antes de que lo aplique.
>
> **Tú:** Aprobado.
>
> **Agente:** El despliegue está en vivo. Aquí tienes la URL, el informe de verificación y todo lo
> que sigue sin verificar. Ahora probaremos los flujos de registro y de datos de la propia app.
> Cuando termines con este proyecto de prueba, `golive teardown` planifica su eliminación para que la
> apruebes antes de borrar nada.

GoLive respeta las decisiones de proveedor que ya tiene tu app y pregunta por lo que falta. Tú te
encargas de los registros, los inicios de sesión en el navegador, las verificaciones de identidad y
las compras. Si en macOS hace falta una clave de API, un diálogo nativo de entrada oculta explica por
qué la pide y dónde se guardará. Su valor va directamente al archivo local de credenciales, nunca al
chat ni a la salida de un comando. En otras plataformas, tu propio editor es la alternativa. Un
cambio posterior en el plan necesita otra aprobación; conectar la autenticación o un dominio puede
requerir un paso adicional después del primer despliegue.

**¿Usas otro proveedor?** El skill tiene un flujo guiado general: comprueba la CLI oficial del
proveedor, una integración MCP oficial disponible o su API y, si hace falta, te guía por su panel. El
agente sigue mostrando el destino, los cambios y el coste antes de pedir aprobación, y después
comprueba lo que puede. Esto es **orientación de mejor esfuerzo** (best-effort), sin garantía de que
se complete ni la misma cobertura de verificación que un adaptador integrado. Si un paso no se puede
completar o verificar, recibes el bloqueo concreto y la siguiente acción. Consulta el [alcance de
proveedores guiados](docs/PROVIDERS.md#guided-providers).

## Qué cubre esta alpha

**Dos opciones de hosting: Vercel y Netlify. Dos opciones de base de datos: Supabase y Neon.**

| Ruta probada en vivo | Qué se ejercitó |
| --- | --- |
| **Vercel + Supabase** | Aprovisionamiento, cableado de variables de entorno, despliegue, CRUD autenticado y aislamiento de acceso |
| **Netlify + Neon** | Aprovisionamiento, cableado de variables de entorno, despliegue, conectividad con Postgres, comprobaciones de API con dos sesiones y CRUD en el navegador |
| **Vercel + Porkbun (dominio personalizado)** | Vinculación del dominio, una escritura de registro DNS aprobada bajo `--confirm-dns`, verificación de propiedad y servicio HTTPS en un subdominio desechable |
| **Vercel + GoDaddy (dominio personalizado)** | El mismo recorrido en un segundo subdominio, incluido el desafío TXT de propiedad que Vercel pidió después de vincular |
| **Vercel + Resend (correo)** | Configuración del dominio de envío, registros DNS, verificación del dominio y un envío real con la clave del propio entorno de la app (entregado; el subdominio nuevo cayó en spam) |
| **Vercel + Stripe (pagos de prueba)** | Claves en modo de prueba y registro del webhook, un rechazo de petición sin firma y un pago real con tarjeta de prueba entregado como evento verificado por firma |
| **Supabase Auth (SMTP + recuperación de contraseña)** | Una escritura de SMTP personalizado releída junto con el límite de correos de auth elevado, y toda la rotación de recuperación en la cuenta de prueba sembrada — solicitud aceptada, respuesta idéntica para una dirección desconocida, token gastado rechazado al reutilizarlo, la contraseña nueva iniciando sesión y la antigua rechazada |

Fueron ejecuciones desechables aprobadas sobre cuentas existentes; los recursos de prueba que ya
habían terminado se eliminaron después, y los proyectos y registros desechables de las ejecuciones
recientes se limpian bajo la misma supervisión. Las combinaciones cruzadas tienen cobertura de mocks,
no una prueba en vivo equivalente. La reutilización del inicio de sesión de la CLI de Supabase pasó
por separado una verificación de solo lectura; la prueba de despliegue completa usó un token
explícito. La configuración de la primera cuenta de un usuario nuevo y cualquier framework de
aplicación no se han validado.

Los comandos de ciclo de vida tienen su propia evidencia: `golive teardown` se ejercitó en vivo sobre
un proyecto desechable de Netlify (bloqueado sin `--confirm-destroy` y después eliminado, con la
lista de sitios de la cuenta intacta salvo por él) y ejecuciones anteriores eliminaron los registros
de GoDaddy y Porkbun que golive había escrito, revocaron las claves de envío de Resend que había
emitido y borraron el endpoint en modo de prueba de Stripe que había registrado. `golive status` se
ejecutó en modo lectura contra un proyecto real; `golive handoff --write` se ejecutó sobre un fixture
desechable que solo tenía Vercel: ambos artefactos se escribieron y se auditaron (una etiqueta de
procedencia en cada fila de afirmación, la prueba de propiedad y la barrera del teardown nombradas,
ningún valor con forma de credencial en el documento, su gemelo JSON, el estado ni la configuración),
y el proyecto se eliminó después mediante el flujo de teardown aprobado — la pila solo tenía host,
así que las filas del documento sobre otros proveedores siguen cubiertas con mocks. Consulta la
[validación observada](docs/VALIDATION.md) para ver la evidencia.

También existen adaptadores experimentales para la configuración de Supabase Auth, el recorrido de
registro de Supabase Auth, su recuperación de contraseña y el aislamiento de cuentas, y para DNS de
Cloudflare. Los ajustes de Supabase Auth —registro, confirmación por correo, longitud mínima de
contraseña, el sistema de correo que usa, además de la URL del sitio y la lista de redirecciones
permitidas— se automatizan mediante un plan aprobado y se releen como evidencia, y esa ruta pasó una
ejecución desechable en vivo: la escritura de la política se mantuvo en la relectura
(`password minimum length: 6 → 12`) y `auth-policy` terminó con el aviso sobre el sistema de correo
integrado como único hallazgo. El recorrido de registro opcional (`auth.e2e`) pasó en esa misma
ejecución: un paso aprobado sembró una cuenta de prueba real (`auth:test-user`, necesita
`--confirm-live`), la dirección no podía iniciar sesión antes de confirmar (`email_not_confirmed`), y
las comprobaciones `auth-signup`/`auth-session` demostraron el correo de registro, la confirmación
exigida, el inicio de sesión confirmado, el token de sesión y el rechazo a un llamante anónimo.
Quedan dos límites: la confirmación se aplicó por la API de administración de Auth y no con el clic
en el correo de la propia cuenta sembrada, y la entrega en la bandeja de entrada la confirma una
persona por diseño — golive nunca ve la bandeja de entrada. Una ejecución posterior aprobada sobre un
fixture desechable (un sitio de Vercel desplegado cuya ruta declarada responde 401 sin sesión, más
una tabla protegida con RLS) ejercitó las dos patas del lado de la app: un GET anónimo de
`auth.protectedPath` respondió 401 y la sonda con sesión iniciada leyó esa tabla como el usuario
autenticado, así que la corrección del bearer en la sonda ya no está cubierta solo con mocks. Lo que
esa evidencia no puede mostrar: la línea de tablas de esa ejecución es un recuento y no nombres de
tabla, y cualquier 401 contaba como protegido —una página de WAF o de mantenimiento daría la misma
lectura—; ambas cosas se corrigieron después (issue #30: la sonda nombra las tablas que leyó, y una
ruta protegida rechazada se corrobora contra la raíz pública, con cobertura de mocks y sin nueva
ejecución en vivo todavía). La recuperación de contraseña está **validada en vivo en el mismo
proveedor**: la misma ejecución del 2026-09-24 llevaba `auth.smtp: resend` (la escritura del SMTP
personalizado y el límite de correos de auth elevado, ambos releídos) y `auth.recovery: true`, cuyo
único paso aprobado (`auth:recovery`, necesita `--confirm-live`) rotó la contraseña de esa cuenta de
prueba registrada con las propias llamadas de recuperación del proveedor — pedir el correo, generar
el enlace con la API de administración, canjearlo por una sesión y fijar la contraseña nueva con esa
sesión — y la comprobación `auth-recovery` pasó todas las patas: la solicitud se aceptó, una
dirección sin cuenta recibió la misma respuesta (sin enumeración de cuentas), el token gastado se
rechazó al reutilizarlo, la contraseña nueva inició sesión y la que sustituyó no. El clic en el
correo y cualquier captcha siguen siendo cosa de una persona (así lo dice el handoff
`auth:recovery-email`), la contraseña SMTP es de solo escritura (el proveedor responde con un hash,
así que la relectura demuestra la configuración, no una entrega) y la cuenta se confirmó por la API
de administración de Auth y no con el clic del propietario. El aislamiento de cuentas también está
implementado en el mismo proveedor: `auth.isolation: true` junto con `auth.identityPath` y
`auth.isolationPath` añade un paso aprobado (`auth:isolation`, necesita `--confirm-live`) que siembra
una **segunda** cuenta de prueba real —la dirección derivada de `auth.testEmail` y la contraseña, de
nuevo, solo en la memoria de esa ejecución— y la confirma por la API de administración del proveedor
(sin un segundo clic en la bandeja de entrada: el recorrido va de los datos de la app, no de la
entrega). La comprobación `auth-isolation` inicia sesión con las dos cuentas y lee las dos rutas
declaradas de la propia app en la URL de producción: ambas deben rechazar a un llamante anónimo (un
200 es un hallazgo crítico); la ruta de identidad de cada cuenta debe responder con su propio id de
usuario y nunca con el de la otra; y la ruta de filas debe devolver solo las filas del llamante
—comprobado con una fila marcadora única por cuenta escrita **a través de esa ruta** con la sesión de
la cuenta y releída después, de modo que el marcador de otra cuenta en la respuesta es una lectura
entre cuentas y falla de forma crítica—. Cuando las rutas no están declaradas, el handoff no
bloqueante `auth:isolation-routes` traspasa la tarea de código de la app; un 404 o una sesión
rechazada se omite con esa tarea nombrada, nunca como un aprobado. El aislamiento de cuentas está
**implementado y cubierto con mocks, todavía no validado en vivo** — su ejecución en vivo llega por
separado. La salida de la propia ejecución de recuperación contenía dos defectos, ambos corregidos
aquí con regresiones con mocks: `teardown` informaba del dominio de envío *adoptado* del propietario
como creado por golive (una lista vacía de marcadores de creación hacía que `[].every()` fuera
verdadero, así que todo dominio registrado se leía como de golive), y el handoff
`auth:recovery-email` mostraba un skipped de un `verify` suelto como su evidencia mientras el estado
registraba ese paso como hecho. Su tercer hallazgo —Resend seguía informando de ese dominio como
verificado mientras los registros que listaba no estaban en el servidor de nombres autoritativo de la
zona— está corregido en
[#52](https://github.com/mikehasa/golive-skill/issues/52): ahora `email-verified` resuelve los
registros que el propio proveedor lista para el dominio antes de aprobar (un dominio verificado
cuyos registros han desaparecido falla; un registro que golive escribió dentro de la ventana de
propagación solo avisa; y un proveedor que no puede listarlos se omite en lugar de aprobar), y el
plan de correo conserva el paso o el handoff `email:dns` para los registros que no resuelven, así que
una marca obsoleta ya no puede ocultarlos. Cubierto con mocks; no se ha vuelto a ejercitar en vivo.
Las rutas de DNS, correo y pagos en modo de prueba que aparecen arriba son las que se han probado,
con las ejecuciones de dominio personalizado usando escrituras de registros en Porkbun y GoDaddy;
**el DNS de Cloudflare en concreto todavía no es una ruta alpha validada**, y los demás proveedores
de autenticación siguen siendo guiados. Consulta el [alcance de proveedores](docs/PROVIDERS.md) y la
[validación observada](docs/VALIDATION.md).

## La lista completa para salir a producción y la hoja de ruta

Una URL que funciona es solo el principio. Según la app, salir a producción puede significar todo lo
siguiente. **GoLive debería averiguar qué puntos se aplican, ayudarte a completarlos y mostrar la
evidencia del resultado.** A un sitio estático no se le debería pedir que monte una base de datos; un
SaaS de pago no debería quedarse en una página de inicio desplegada.

Esta es nuestra hoja de ruta de producto en forma de lista de verificación de lanzamiento. Las marcas
y los tachados señalan **hitos concretos probados en vivo**, no una categoría terminada ni una lista
de verificación completada para tu app.

**✅ Probado en vivo** · **🚧 En curso / experimental** (el código existe; el recorrido completo está pendiente) · **🗺️ Planificado**

### Publicar la app

- [x] ✅ **Hosting de frontend:** ~~Demostrar el despliegue en Vercel y Netlify.~~ Compilar, desplegar
  y verificar el proyecto previsto en las dos rutas probadas.
- [x] ✅ **Base de datos:** ~~Demostrar el aprovisionamiento y la conexión con Supabase y Neon.~~ Las
  rutas probadas incluyen el cableado de variables de entorno y comprobaciones de CRUD desde la
  aplicación.
- [x] ✅ **Cableado de variables de entorno:** ~~Conectar las credenciales de hosting y base de datos
  en las dos rutas probadas.~~ La rotación de secretos y la gestión del ciclo de vida de los entornos
  a un nivel más amplio siguen planificadas.
- [ ] 🗺️ **Backend / servidores:** servicios de API dedicados, contenedores, servidores persistentes,
  configuración en tiempo de ejecución y comprobaciones de salud. Las rutas de la app ya se despliegan
  a través de los hosts soportados.
- [ ] 🗺️ **Esquema y datos:** migraciones revisadas, despliegue seguro, separación de entornos y
  comprobaciones de los datos de la app. En las pruebas en vivo se supervisaron por separado; el flujo
  reutilizable sigue planificado.
- [ ] 🗺️ **Almacenamiento de archivos y objetos:** buckets, subidas, reglas de acceso, URL firmadas y
  políticas de ciclo de vida.

### Convertirlo en un producto completo

- [ ] 🚧 **Autenticación:** registro, inicio de sesión, sesiones, recuperación de contraseña y
  aislamiento de cuentas. La política de auth de Supabase (registro, confirmación por correo, longitud
  mínima de contraseña, sistema de correo) y la URL del sitio y la lista de redirecciones permitidas se
  escriben mediante un plan aprobado, se releen como evidencia y las verifican las comprobaciones
  `auth-policy`/`auth-redirects` — ejercitadas en una ejecución desechable aprobada, donde la escritura
  de la política se mantuvo en un mínimo de doce caracteres. El recorrido opcional (`auth.e2e: true`)
  pasó en esa misma ejecución: el paso `auth:test-user` sembró una cuenta de prueba real, esa dirección
  no podía iniciar sesión antes de confirmar, y las comprobaciones `auth-signup`/`auth-session`
  demostraron el correo de registro, la confirmación exigida, el inicio de sesión confirmado y el token
  de sesión — **validado en vivo para Supabase en proyectos desechables, donde la confirmación llegó
  por la API de administración de Auth en lugar del clic en el correo sembrado, la entrega en la
  bandeja de entrada siguió siendo confirmada por una persona y una ejecución posterior demostró una
  ruta protegida declarada (un 401 anónimo) y una lectura autenticada de una tabla protegida con RLS,
  informada como un recuento y no como el nombre de la tabla**. La recuperación de contraseña está
  **validada en vivo en el mismo proveedor** (`auth.recovery: true` añade el paso `auth:recovery` y la
  comprobación `auth-recovery`, que demostraron que no hay enumeración de cuentas, que el token es de
  un solo uso y que la contraseña se sustituye, en un proyecto desechable; la confirmación llegó por la
  API de administración de Auth, el clic en la bandeja de entrada sigue siendo cosa de una persona, y
  los dos defectos de salida que encontró esa ejecución —una afirmación falsa de propiedad del tipo
  «creado por golive» y un texto de evidencia en el handoff que contradecía el paso registrado— están
  corregidos con regresiones con mocks). El aislamiento de cuentas —la otra mitad, y la que las
  ejecuciones anteriores no pudieron ejercitar— está
  implementado y cubierto con mocks de la misma forma: `auth.isolation: true` junto con
  `auth.identityPath` y `auth.isolationPath` añaden el paso `auth:isolation` (una **segunda** cuenta de
  prueba real, confirmada por la API de administración del proveedor y registrada por id y dirección)
  y la comprobación `auth-isolation`, que inicia sesión con ambas cuentas y demuestra en las rutas de
  la propia app que ninguna puede leer la identidad ni las filas de la otra (una lectura entre cuentas
  falla de forma crítica; una ruta no declarada o un 404 se omite con la tarea de código de la app). Su
  ejecución en vivo llega por separado también. Los demás proveedores de autenticación siguen siendo
  guiados.
- [ ] 🗺️ **OAuth / inicio de sesión social / SSO:** registro de clientes, pantallas de consentimiento,
  ámbitos, URL de callback y revisiones del proveedor. La configuración actual de proveedores de
  autenticación es guiada.
- [x] ✅ **Pagos y suscripciones:** ~~Demostrar el pago en modo de prueba y la aceptación de webhooks con Stripe.~~
  Un pago real con tarjeta de prueba entregó un evento `checkout.session.completed` verificado por
  firma. La preparación para modo live, los derechos de suscripción (entitlements), los reembolsos y
  los eventos de suscripción todavía necesitan validación.
- [x] ✅ **Correo transaccional:** ~~Demostrar la configuración del dominio de envío, su verificación y la entrega real con Resend.~~
  Un envío con la clave del propio entorno de la app llegó a destino (a spam en un subdominio nuevo,
  todavía sin DMARC). Con `auth.smtp: resend`, el paso `auth:smtp` también escribe el SMTP personalizado
  del proyecto de auth —el host, el puerto y el usuario de Resend, el remitente que la app ya usa y una
  contraseña SMTP tomada de una clave de envío que golive emitió (la del recorrido de correo, o una que
  emite solo para SMTP)— y en la misma escritura eleva el límite de correos de autenticación del propio
  proyecto (`rate_limit_email_sent`) a 30 por hora (o a `auth.emailRateLimitPerHour`), porque el
  proveedor guarda ese límite junto con el SMTP personalizado. Después, `auth-policy` informa
  `custom SMTP via Resend` en lugar de avisar sobre el sistema de correo integrado. La contraseña es de
  solo escritura (el proveedor devuelve un hash), así que la relectura confirma la configuración y un
  correo de autenticación real es la única prueba completa. **Validado en vivo en un proyecto
  desechable (2026-09-24)**: esa misma ejecución escribió el SMTP personalizado y lo releyó
  (`smtp.resend.com`, puerto 465, usuario `resend`, remitente `auth@mail.trytofu.xyz`) junto con
  `auth email rate limit: 2 → 30 per hour`, emitió la clave SMTP por sí misma y la revocó en el
  teardown, y después `auth-policy` leyó `custom SMTP via Resend` con 30 correos de auth por hora
  —solo la configuración y el límite, porque la contraseña nunca se puede releer. La gestión de
  rebotes, contenidos de mensaje más ricos y la entrega real en la bandeja de entrada (confirmada por
  una persona por diseño, y dudosa en el dominio de esa ejecución — véase
  [issue #52](https://github.com/mikehasa/golive-skill/issues/52)) todavía necesitan validación.
- [x] ✅ **Dominios / DNS / HTTPS:** ~~Demostrar la vinculación de dominios, el cableado DNS y el servicio HTTPS en parejas host+DNS.~~
  Probado: vinculación en Vercel con escrituras de registros en Porkbun y GoDaddy bajo
  `--confirm-dns`, verificación de propiedad y HTTPS 200 en subdominios desechables. El adaptador de
  DNS de Cloudflare, las redirecciones y más combinaciones de host todavía necesitan validación en
  vivo.
- [ ] 🗺️ **SMS y notificaciones push:** registro de remitentes, credenciales, permisos y
  comprobaciones de entrega.
- [ ] 🗺️ **Servicios de terceros y de IA:** acceso a API, ámbitos, callbacks, cuotas y pruebas
  funcionales. Hoy se detectan las variables de entorno que faltan; los flujos específicos por
  servicio están planificados.
- [ ] 🗺️ **Trabajo en segundo plano:** tareas programadas (cron), colas, workers, reintentos y
  recuperación de trabajos fallidos.
- [ ] 🗺️ **Caché, búsqueda y tiempo real:** cachés, índices de búsqueda y vectoriales, y servicios en
  tiempo real cuando hagan falta.

### Lanzar con confianza y luego mantenerlo en marcha

- [ ] 🗺️ **Seguridad y control de abuso:** políticas de acceso, credenciales expuestas, cabeceras de
  seguridad, límites de frecuencia y protección contra bots. Hoy existen comprobaciones acotadas de
  RLS/advisor y de patrones de credenciales.
- [ ] 🗺️ **Monitorización y alertas:** seguimiento de errores, logs, disponibilidad y alertas
  accionables. Hoy las sugerencias de proveedores son guiadas; la configuración verificada está
  planificada. Existen comprobaciones de deriva bajo demanda (`golive status`, más abajo) — la
  monitorización continua y las alertas no.
- [ ] 🗺️ **Analítica de producto:** validación de eventos y ajustes de consentimiento y datos, más
  allá de las sugerencias guiadas de proveedores que hay hoy.
- [ ] 🚧 **CI/CD y releases seguros:** previews, comprobaciones de release, promoción, reversión y
  detección de deriva, sobre los despliegues por CLI aprobados que ya existen. **Identidad del
  despliegue — implementado, no validado en vivo:** cada despliegue correcto registra la identidad
  propia del proveedor para el despliegue que hizo (`deployed:<target>:id` =
  `<provider>|<deployment id>|<url>|<time>` en `.golive/state.json`, cubierto con mocks; un proveedor
  que no informa de ninguna identidad no registra nada), de modo que una capacidad posterior pueda
  nombrar un despliegue exacto. **Despliegue de preview y comprobación de release, opcionales —
  implementados, no validados en vivo:** con `release.preview: true` en `golive.yaml` (y `preview` en
  `targets`), `plan` añade `preview:deploy` —una creación que despliega el árbol de trabajo actual al
  destino de preview del host, nombra el proveedor, el proyecto, el entorno de destino y el proyecto
  de origen que la preview comparte con producción, necesita `--confirm-live` cuando un valor en modo
  live rellena el nombre de una variable de entorno de la preview, y registra la identidad propia del
  proveedor como `deployed:preview:id`— y `release:check`, que no escribe nada, declara
  `preview:deploy` como requisito previo y falla el plan cuando falla la lectura de ese despliegue por
  parte del proveedor o un escaneo de credenciales de su paquete. En un plan que construye un
  candidato de release, esa comprobación es el último paso, de modo que lo que condiciona es la
  promoción (cuyo propio plan vuelve a ejecutar la comprobación antes de cambiar producción), no el
  despliegue a producción que ese mismo plan ya ha emitido antes. **Promoción y reversión —
  implementadas, no validadas en vivo:** con
  `release.promote: true` (además del opt-in de preview) un plan pide un release por promoción, y con
  `release.rollback: true` pide volver a apuntar producción a un despliegue anterior que el propio
  golive creó y registró. `promote:production` nombra el id exacto del despliegue que convertiría en
  producción —el proveedor solo informa del id de un despliegue cuando el despliegue ya existe, así
  que construir el candidato y promoverlo son dos planes, y el plan que apruebas dice cuál de los dos
  es—, está condicionado por `release:check`, que vuelve a leer ese despliegue dentro del mismo plan, y
  **no necesita ningún indicador de confirmación extra**: el id del plan, el despliegue nombrado y la
  comprobación recién hecha son la aprobación. Ambos pasos releen el despliegue objetivo y lo que
  sirve producción antes de escribir, y demuestran lo que sirve producción después; ambos conservan la
  parada entre releases (ninguno es `replayable` ni un borrado), y ninguno es automático: ninguna
  comprobación fallida dispara una reversión, y un despliegue creado desde un panel, un push de Git o
  un pull request nunca es objetivo de promoción ni de reversión (es un handoff, y así se indica). Lo
  que admite cada host es distinto y golive se niega en lugar de adivinar: Netlify relee su despliegue
  publicado y puede restaurar uno anterior, así que ambos pasos funcionan allí; Vercel no expone
  ninguna lectura de lo que sirve producción ni ninguna llamada de promoción o reversión que golive
  haya ejercitado, así que en Vercel no se promueve ni se revierte nada y un aviso explica por qué.
  `production-release` demuestra lo que sirve producción, nombra lo que servía antes e informa como
  handoff un despliegue que golive nunca registró. Añadir estos ids de paso cambia el id de un plan,
  así que una aprobación que no se llegó a aplicar hay que volver a planificarla. Las comprobaciones de
  preview (y por tanto la promoción) se omiten en un host que no expone ninguna lectura por despliegue
  (Vercel), informando de eso en lugar de adivinar. La detección de deriva existe como el comando de
  solo lectura `golive status` que se describe más abajo (se ejecutó en modo lectura en la validación
  de auth y no tuvo nada accionable una vez que ese recorrido pasó, pero las líneas base de DNS,
  entorno, webhook y despliegue que compara todavía carecen de evidencia en vivo), y los despliegues
  de preview aún no están entre los asuntos que compara.
- [ ] 🗺️ **Copias de seguridad y recuperación:** retención, simulacros de restauración, pasos para
  incidentes y limpieza aprobada. El `teardown` aprobado elimina lo que golive creó; las copias de
  seguridad y cualquier restauración siguen siendo trabajo manual y supervisado.
- [x] ✅ **Desinstalación / teardown:** ~~un inventario aprobado de los recursos creados por golive y su eliminación.~~
  `golive teardown` planifica la eliminación, borra solo lo que golive puede demostrar que creó
  (pruebas de propiedad y `--confirm-destroy`) y vuelve a leer, después de borrar, la lista de
  registros propiedad de golive de la zona DNS y la lectura del proyecto del propio host. Nada de lo
  que no puede eliminar se descarta en silencio: un sobrante —una zona ilegible, un proyecto del host
  que no se puede eliminar, un proveedor sin sesión iniciada— se convierte en un handoff que nombra
  qué queda y la solución exacta, y los proyectos de Supabase/Neon y el dominio de envío de Resend
  siguen siendo handoffs manuales
  ([#9](https://github.com/mikehasa/golive-skill/issues/9)). Una eliminación olvida la línea base que
  golive había registrado para ese recurso, así que `golive status` no informa del propio teardown de
  golive como deriva, y una clave de envío que golive revocó se informa como warning en lugar de como
  pass, porque el proveedor no ofrece ninguna lectura que lo confirme.
- [ ] 🗺️ **Costes y cuotas:** elección de planes, presupuestos, alertas y comprobaciones de capacidad.
  Hoy existen guardas acotadas para el plan gratuito; la gestión continua de costes está planificada.
- [ ] 🗺️ **Esenciales del lanzamiento:** metadatos, previsualizaciones al compartir, indexación,
  accesibilidad, enlaces de soporte y páginas de políticas revisadas por el propietario.
- [ ] 🚧 **Propiedad y traspaso (handoff):** cuentas, recursos, accesos, responsabilidades de renovación
  e instrucciones de mantenimiento. `golive handoff --write` registra la ruta de inicio de sesión, las
  pruebas de propiedad, los trabajos recurrentes y las barreras de eliminación en
  `GOLIVE_HANDOVER.md`, etiquetando cada fila como verificada, registrada, no verificable o
  desconocida, y `golive status` vuelve a leer esos asuntos cuando se lo pides: compara las líneas base
  que golive registró con los proveedores tal como están ahora, y nombra lo que no ha podido leer.
  Volver a fijar la línea base de la deriva sigue siendo manual y aprobado — el comando está
  implementado y se ejecutó en modo lectura en la validación de auth, pero la validación en vivo de
  todos los asuntos de deriva sigue pendiente.

Algunos pasos siempre necesitarán a una persona: aceptar términos, verificar identidad, comprar, elegir
la facturación y pasar las revisiones que exija un proveedor. «Guiado» debería seguir significando una
acción siguiente clara, la página correcta, los permisos correctos, una comprobación después y la
vuelta al mismo flujo de trabajo. Cuando la app necesite cambios de código, GoLive debería darle al
agente de programación una tarea concreta y volver a comprobar el resultado. No debería hacerte
coordinar una docena de conversaciones de configuración inconexas.

**Lo siguiente:** completar y probar en vivo los recorridos de lanzamiento que quedan —la ejecución en
vivo del aislamiento de cuentas (implementado y cubierto con mocks en Supabase, todavía no ejercitado
contra un proyecto real), los flujos de pago en modo live y el adaptador de DNS de Cloudflare— y
después ampliar las arquitecturas de app y las operaciones continuas.

Estas son direcciones, no fechas de entrega. Una capacidad solo debería salir de experimental después
de que se hayan ejercitado la configuración de su cuenta, la conexión, la verificación y la
recuperación. Las contribuciones a cualquier parte de esta lista son bienvenidas, sobre todo la
evidencia de dónde se atasca un lanzamiento real.

<details>
<summary>Listas de verificación de producción que inspiran esta hoja de ruta</summary>

El alcance se apoya en la [lista de verificación de lanzamiento de Vercel](https://vercel.com/docs/production-checklist),
la [lista de verificación de producción de Supabase](https://supabase.com/docs/guides/deployment/going-into-prod),
la [lista de verificación de salida a producción de Stripe](https://docs.stripe.com/get-started/checklist/go-live),
la [guía de producción de OAuth de Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
y la [guía de producción de Next.js](https://nextjs.org/docs/pages/guides/production-checklist).
Inspiran los objetivos de arriba; no son funcionalidades de GoLive ni requisitos universales para toda
app.

</details>

## Verificación que puedes inspeccionar

El informe registra resultados **pass, fail, warning y skipped**, junto con los pasos humanos que
quedan. Las comprobaciones incluyen el acceso a las cuentas, los nombres de las variables de entorno,
las URL de despliegue confirmadas por el proveedor, patrones de secretos en el JavaScript público, el
acceso a la base de datos, ajustes soportados de autenticación, webhooks y DNS y (cuando el host puede
responder) el despliegue que el proveedor dice que sirve producción.

Que un despliegue esté listo no prueba que la app funcione. Un nombre de variable de entorno puede
existir con un valor equivocado. Un dominio de correo verificado no demuestra que los correos lleguen
a la bandeja de entrada. Los eventos de pago firmados, el registro y los flujos de negocio de la app
necesitan pruebas funcionales. **Un skipped no es un aprobado.**

Tu app recibe `golive.yaml`, `.golive/state.json`, `.golive/report.json` y `GOLIVE_REPORT.md`. El
estado conserva los ids de los recursos y la evidencia de cada paso para la recuperación; no es un
almacén de credenciales. `golive teardown` elimina lo que golive creó después de su propia aprobación
y de `--confirm-destroy`; no existe ningún comando de reversión, restauración o reconciliación
general entre proveedores para esos recursos — `release:rollback` (opcional) solo vuelve a apuntar
producción a un despliegue anterior que el propio golive registró, y no toca ningún recurso de datos,
DNS, pagos ni correo.

`golive handoff --write` añade el documento de propiedad: `GOLIVE_HANDOVER.md` en la raíz del
repositorio y su origen JSON en `.golive/handover.json`. Nombra las cuentas y la ruta de inicio de
sesión, cada recurso que golive creó y la prueba de que es suyo, lo que sigue siendo manual, lo que se
repite, cómo funciona la eliminación y qué comandos vuelven a comprobar cada asunto. Cada fila dice si
se verificó en esa ejecución, se registró antes, golive no puede verificarla o es desconocida; golive
no leyó ningún dato de facturación, así que no se indica ninguna cifra de coste. Los archivos no
contienen valores secretos, pero los metadatos sin secretos pueden identificar igualmente recursos
privados — revísalos antes de compartirlos. `--write` nunca sobrescribe un archivo que golive no haya
generado, salvo que se pase `--force`.

`golive status` plantea la pregunta de seguimiento: ¿ha cambiado algo a espaldas de golive desde que
registró lo que hizo? Compara las líneas base registradas —los registros DNS que golive escribió, los
**nombres** de las variables de entorno que entregó, el endpoint de webhook registrado, la vinculación
del dominio, el proyecto de base de datos y sus selectores de conexión, el dominio de envío, la cuenta
de pagos que hay detrás de las claves de la app, el proyecto del host— con lecturas tomadas ahora, y
etiqueta ambos lados: `expected (recorded by golive <time>)` frente a `observed (read now)`. Cada
elemento dice quién puede actuar: volver a ejecutar una comprobación, replanificar y aplicar un cambio
aprobado, o una decisión que solo puede tomar una persona. Es de solo lectura: no genera archivo de
informe, no escribe en el proveedor, no cambia el estado, y termina con el código `2` cuando hay algo
que atender. Un proveedor que no puede leer se informa como no verificable — nunca como limpio y nunca
como fallo — y nunca vuelve a fijar ninguna línea base por su cuenta. La deriva no es una barrera a
propósito: `plan`, `apply` y `verify` nunca la consultan. `status` está **implementado**, y se ejecutó
en modo lectura durante la validación de auth de Supabase (un paso fallido apareció como accionable y
después, al completarse, la lista quedó vacía), pero la validación en vivo de los asuntos de deriva que
quedan sigue pendiente.

## Credenciales y control

- **Aprueba antes de tocar ninguna cuenta.** Los planes nombran los destinos y las escrituras
  previstas, y `apply` se niega sin el id del plan aprobado y sin `--yes`. Cambiar el release instalado
  invalida las aprobaciones antiguas. Los pasos de DNS, de pago en live y de borrado tienen barreras
  adicionales (`--confirm-dns`, `--confirm-live`, `--confirm-destroy`), y el primer despliegue a
  producción de un proyecto también necesita `--confirm-live`, porque antes bastaba con aprobar un plan
  para escribir en producción por primera vez. [Confianza, acceso y
  control](docs/TRUST.md#what-golive-may-write-and-what-comes-first) recorre cada barrera.
- **Mantén los secretos fuera del chat.** Los inicios de sesión de proveedores soportados se
  reutilizan. En macOS, un diálogo nativo de entrada oculta puede guardar la clave de API que haga
  falta; tu propio editor es la alternativa. Las claves viven en `~/.config/golive/credentials`, un
  archivo local en texto plano con permisos 0600 fuera del repositorio de tu app — no es un llavero del
  sistema, así que cualquier cosa que se ejecute como tu usuario puede leerlo. El código de ejecución
  mantiene los valores fuera de argv, planes, estado, informes y la salida de los comandos, y guarda
  huellas en lugar de valores. `golive credentials --remove NAME --yes` elimina una entrada guardada,
  de forma irreversible; lo que pone fin al acceso de verdad es revocar el token en el proveedor. Las
  contraseñas de inicio de sesión del Mac se quedan en los diálogos de autenticación de macOS o del
  proveedor; GoLive nunca te pide que escribas una en su diálogo de claves. La frontera completa está
  en [confianza, acceso y control](docs/TRUST.md#the-credential-boundary).
- **Las actualizaciones tienen dueño.** Skills CLI gestiona sus propias instalaciones. El instalador
  propio opcional admite actualizaciones del paquete completo y reversión local; la sustitución
  automática está desactivada por defecto. Actualiza entre ejecuciones de despliegue, nunca entre un
  plan y su `apply`. La reversión no afecta a los recursos en la nube.
- **Tus cuentas siguen siendo tuyas.** GoLive no compra servicios ni crea cuentas de facturación. Tu
  agente de programación, los proveedores y el instalador tienen sus propias prácticas de datos.

## Contribuir

🤝 **Estamos empezando y nos encantaría contar con tu ayuda para dar forma a GoLive.** Los informes de
errores, las ideas de funcionalidades, las correcciones de documentación y los pull requests son
bienvenidos. No hace falta que construyas un adaptador para contribuir: una instrucción de inicio de
sesión poco clara o un lanzamiento real que se atascó también son comentarios útiles.

Abre un issue para reportar un problema o comentar una idea, o envía un pull request acotado. Si quieres
añadir un proveedor o un flujo de trabajo grande, plantéate abrir antes un issue para que acordemos el
alcance juntos. Nunca incluyas secretos ni respuestas de autenticación en bruto en un informe.

Consulta **[CONTRIBUTING.md](CONTRIBUTING.md)** para la configuración local, las pruebas y tu primera
contribución. La [arquitectura](docs/ARCHITECTURE.md), [confianza, acceso y
control](docs/TRUST.md), [recuperación](docs/RECOVERY.md), el [alcance de
proveedores](docs/PROVIDERS.md) y el [registro de validación](docs/VALIDATION.md) explican qué existe
y dónde hace falta ayuda.

[Licencia MIT](LICENSE). Los avisos de terceros incluidos están en
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
