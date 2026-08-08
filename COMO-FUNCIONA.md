# Cómo funciona Wingman, en simple

Sin jerga. Si algo aquí no se entiende, es un error del documento, no tuyo.

## El problema en una frase

Cada herramienta de IA tiene memoria, pero ninguna recuerda **por las otras**, y ninguna recuerda
en tu **otra computadora**.

## La idea, con una analogía

Piensa en un **grupo de WhatsApp** entre tus computadoras y tus herramientas de IA.

- Cada quien manda sus propios mensajes.
- Nadie edita los mensajes de otro.
- Pero la conversación es **una sola** y todos la leen completa.

Eso es exactamente Wingman. Cada máquina escribe en su buzón; todas leen el hilo entero.

## Las tres cosas que hace

### 1. Guardar

Cuando terminas de trabajar (o cuando se te acaba el límite), tu herramienta de IA escribe un
resumen corto: qué querías lograr, qué decidiste, qué probaste que no funcionó, y cuál es el
siguiente paso.

No guarda la conversación entera. Guarda **el estado**. El código ya está en tu disco; lo que se
pierde al cambiar de herramienta es el razonamiento, no el diff.

### 2. Sincronizar

Ese resumen se sube a un repositorio **privado** de GitHub, en **tu** cuenta, llamado
`wingman-memory`.

No hay servidor de Wingman. No hay cuenta que crear. No existe a dónde mandar tus datos aunque
quisiéramos.

### 3. Cargar

Cuando abres cualquier herramienta de IA en cualquier computadora, Wingman baja el hilo completo y
se lo entrega. La herramienta arranca sabiendo todo lo anterior.

## Por qué los ganchos no imprimen nada

Cada agente tiene una idea distinta de lo que un gancho puede imprimir. Claude Code inyecta lo que
salga por stdout. Gemini CLI exige JSON estricto y **se rompe con un solo carácter suelto**. Codex
espera su propio sobre. Y esos formatos cambian entre versiones.

Por eso los ganchos de Wingman **no imprimen absolutamente nada**. Lo que hacen es refrescar el
archivo `.wingman/CONTEXT.md`, y el archivo de instrucciones de cada herramienta apunta a él:

```
Gancho al arrancar  →  refresca .wingman/CONTEXT.md  →  salida vacía
                                 ↑
       CLAUDE.md / AGENTS.md / GEMINI.md / .cursor/rules lo importan
```

El silencio es la única salida que ningún parser puede rechazar. Así el gancho no puede romper tu
herramienta, ni hoy ni dentro de tres versiones.

Tus propias instrucciones en esos archivos se conservan, se respaldan antes de tocarlas, y
`wingman uninstall` borra solo el bloque de Wingman.

Wingman tampoco escribe **nunca** en `~/.codex/config.toml`. Ahí viven tus credenciales y la
configuración del proveedor; un error de escritura rompería mucho más que Wingman. Usa el archivo
`hooks.json`, que es exclusivo para eso.

## Cómo sabe qué proyecto es cuál

**En la terminal:** por la carpeta donde estás. Sin ambigüedad.

Pero la carpeta se llama distinto en cada máquina (`~/proyectos/miapp` en casa,
`D:\trabajo\miapp` en la oficina). Por eso Wingman **no usa la ruta**: usa el **remote de git**.
Si ambas carpetas apuntan a `github.com/tu/miapp`, es el mismo proyecto. Automático.

Para carpetas sin git, te pide un nombre una vez.

**En el navegador:** no hay carpeta, así que el identificador **viaja dentro del texto**. Cuando
haces `wingman paste`, el bloque copiado incluye una línea oculta:

```
wingman: a3f9c21b8e04-miapp
```

Pegas eso en ChatGPT. Cuando traes la respuesta con `wingman capture`, Wingman lee esa línea y
sabe a qué proyecto pertenece — aunque estés parado en otra carpeta, aunque hayan pasado días.

## Por qué nunca hay conflictos de git

Este es el truco central del diseño.

Cada máquina escribe **solo dentro de su propia carpeta**, con nombres de archivo que llevan la
fecha exacta y una huella corta de esa computadora:

```
projects/a3f9c21b8e04-miapp/
  journal/
    pc-trabajo--3f2a/     ← solo la PC del trabajo escribe aquí
    pc-casa--91cd/        ← solo la PC de casa escribe aquí
    laptop--b70e/         ← solo la laptop escribe aquí
```

Como dos máquinas nunca tocan el mismo archivo, **git no tiene nada que fusionar**. Dos
computadoras pueden hacer push en el mismo segundo y las dos escrituras sobreviven.

Esas carpetas son **buzones, no paredes**. Al leer, Wingman junta todo y lo ordena por fecha.

La huella de 4 caracteres al final existe por si nombras dos máquinas igual. Aunque las dos se
llamen "laptop", sus carpetas siguen siendo distintas, y todo sigue funcionando.

## Qué pasa cuando algo falla

Diseñado para que nunca te deje tirado:

| Situación | Qué pasa |
|---|---|
| No hay internet | Guarda local y encola. Sube en el siguiente comando. |
| No tienes GitHub conectado | Funciona en modo local. Te dice cómo activar sync cuando quieras. |
| GitHub caído | Igual que sin internet. Nada se pierde. |
| Dos procesos a la vez | Se turnan con un candado. Ambas entradas quedan. |
| El repo resultó público | **Se niega a subir nada** y te dice cómo arreglarlo. |
| Algo falla dentro de un hook | El hook siempre termina bien. Tu sesión de IA nunca se rompe. |

## Qué NO hace

- **No lee tu código.** Solo guarda los resúmenes que escriben tus herramientas de IA.
- **No toca tus cuentas de IA.** No sabe ni le importa con qué cuenta de ChatGPT o Claude estás.
- **No manda nada a terceros.** Solo a tu repo privado.
- **No te espía.** Cero telemetría. El código es abierto, puedes revisarlo.

## Sobre los secretos

Antes de escribir cualquier archivo, Wingman busca claves de API, tokens, contraseñas y llaves
privadas, y los reemplaza por `[redacted-by-wingman]`. Como pasa **antes** de escribir, un secreto
nunca llega al historial de git — que es de donde ya no se puede sacar.

Reconoce tokens de GitHub, OpenAI, Anthropic, AWS, Google, Slack, Stripe, GitLab, npm, JWTs,
bloques de llave privada, y credenciales dentro de URLs.

No es infalible. No pegues secretos a propósito.

## La bóveda: cuando sí quieres guardar un secreto

La redacción protege el diario, que se sube a GitHub y se replica en todas tus máquinas. Pero a
veces quieres que tus agentes vean algo sensible **en esta computadora y en ninguna otra**.

```bash
wingman vault -m "La key de staging está en 1Password, bóveda Acme."
```

Eso se inyecta en todos tus agentes de esta máquina, y **nunca se commitea ni se sincroniza**. Vive
en una carpeta fuera del store, así que ninguna bandera puede subirlo por accidente: simplemente no
existe código que lo meta en un commit.

Ahí el contenido se guarda **tal cual**, secretos incluidos, porque para eso es. Hay pruebas que
verifican que no aparece ni en el store, ni en ningún commit, ni en el historial de git.

```bash
wingman vault           # verla
wingman vault --clear   # borrarla
```

## Los checkpoints rodantes

Si esperas a quedarte sin contexto para pedir un resumen, ya es tarde: el modelo que necesitas para
resumir es el que ya no puede responderte.

Por eso Wingman guarda un checkpoint pequeño cada 20 minutos de trabajo activo, sin llamar a ningún
modelo. Lee del disco: la rama, el último commit, qué archivos cambiaron. Cuesta cero tokens y
siempre hay algo reciente guardado.

No reemplaza a un traspaso escrito por el agente —ese es mucho mejor porque sabe *por qué* pasaron
las cosas— pero garantiza que nunca te quedes sin nada.

## Por qué texto plano y no cifrado

Porque puedes:

- Abrir el repo desde el celular y leer tu contexto.
- Hacer `grep` para encontrar esa decisión de hace tres semanas.
- Ver el `git diff` de qué cambió.
- Confiar en la herramienta, porque puedes abrir la carpeta y ver exactamente qué se guardó.

Cifrar protege contra GitHub. Pero el repo ya es privado y tuyo, y si pierdes la frase pierdes la
memoria para siempre. Si de verdad lo necesitas, `--encrypt` llega en la v1.1.

## Los cinco comandos que importan

```bash
npx wingman-ai@latest init   # una vez por máquina
wingman load                 # ver el contexto
wingman save                 # guardar un traspaso
wingman paste                # llevarlo a un chat web
wingman capture              # traerlo de vuelta
```

Y si algo se ve raro:

```bash
wingman doctor               # te dice qué falta y cómo arreglarlo
```
