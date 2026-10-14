# Plan: servicio de agentes para Tern equivalente a herdr

Objetivo: ofrecer el **mismo contrato de agentes que herdr** mediante una integración propia para Tern: estados reales, nombres e identidad, permisos y preguntas, espera fiable y envío seguro de prompts.

Alcance inicial:
- Integraciones para **omp, claude y codex**.
- Estados: `idle`, `working`, `blocked`, `done`, `unknown`.
- Comandos del CLI: `list`, `get`, `read`, `wait`, `prompt`, `start`.
- El aside consume el estado del servicio a través de su caché actual, sin una segunda lectura paralela.

Referencia de comportamiento: **herdr 0.8.2 instalado**, especialmente `agent list/get/wait/prompt/start`.

No forma parte de esta entrega: convertir esos estados en los estados nativos de todos los consumidores internos de Tern.

## 1. Interfaces

- [x] Definir el formato del reporte: `source`, `agent`, `state`, `message?`, `seq`, identidad de sesión y comando de reanudación.
- [x] Especificar el almacenamiento del estado: archivo por pane, estado más reciente y números de secuencia por fuente.
- [x] Definir el esquema del CLI: `list`, `get`, `read`, `wait`, `prompt`, `start`, con JSON estable.
- [x] Especificar el contrato que consume el aside: transiciones por pane, foco y orden determinista de la cola.
- [x] Detallar la detección del estado: quién clasifica pregunta, permiso, `unknown` y salida del proceso.

## 2. Conectores de los agentes

- [x] Crear el conector de omp a partir de los eventos reales: inicio, fin, `ask`, solicitud y resolución de permisos, reintentos y cambio de sesión.
- [x] Agregar el estado `blocked` con mensaje para preguntas y permisos.
- [x] Publicar comandos de reanudación por pane y liberar el pane al salir.
- [x] Repetir el diseño para claude y codex con sus eventos o superficies reales.
- [x] Mantener los reportes en segundo plano, sin bloquear el agente, y descartar estados anteriores.

## 3. Servicio de estado

- [x] Aceptar reportes solo de fuentes conocidas y exigir números de secuencia crecientes.
- [x] Descartar reportes atrasados o de sesiones anteriores.
- [x] Arbitrar entre reporte del conector y señales del terminal.
- [x] Derivar `done` como `idle` aún no visto, sin marcarlo visto por una lectura del CLI.
- [x] Marcar visto solo ante foco o navegación explícita del usuario.
- [x] Limpiar nombre, estado y reanudación cuando el pane sale o el proceso termina.
- [x] Publicar `idle`, `working`, `blocked`, `done` y `unknown` con identidad y motivo del bloqueo.

## 4. CLI compatible

- [x] Implementar `list` con nombre, estado, identidad, motivo y foco.
- [x] Implementar `get` por nombre o ID del pane.
- [x] Implementar `read` con historial suficiente para inspeccionar preguntas y permisos.
- [x] Implementar `wait` por defecto para `idle`, `done` o `blocked`.
- [x] Implementar esperas específicas con `--until`, incluyendo `unknown` solo cuando se pida.
- [x] Implementar `start` que verifique el agente esperado, en el mismo panel, listo para recibir input.
- [x] Implementar `prompt` que rechace un agente bloqueado antes de escribir.
- [x] Devolver `agent_prompt_stalled` cuando un envío aceptado no produzca cambio de estado en 5 segundos.
- [x] Devolver `agent_not_ready` cuando el agente no esté listo al arrancar.
- [x] Mantener esperas indefinidas solo cuando el usuario no fije `--timeout`.

## 5. Integración con el aside

- [x] Consumir el servicio como entrada del caché actual de agentes, sin una lectura independiente.
- [x] Conservar badges actuales: `working` → `◐`, `waiting_input`/`blocked` → `?`, turno terminado sin ver → `✓`, fallo → `!`.
- [x] Conservar sonidos actuales: fin de turno en fondo → `done`, pregunta o permiso → `request`.
- [x] Mantener prioridad existente ante eventos simultáneos: pregunta antes que fin de turno.
- [x] Preservar presupuesto actual: un solo spawn por hook y ninguna E/S en el tick de pintado.
- [x] Documentar equivalencias de estado en inglés sin repetir la licencia del plugin.

## 6. Verificación de paridad

- [x] Probar que el reporte de pregunta de omp produce `blocked` con mensaje, `?` y sonido `request`.
- [x] Probar que un permiso real produce `blocked`, no un falso `working` ni `idle`.
- [x] Probar que un turno terminado sin ver produce `done`, tilde `✓` y sonido de fin de turno.
- [x] Probar que una lectura del CLI no marca `done` como visto.
- [x] Probar que `prompt` rechaza un agente bloqueado antes de escribir.
- [x] Probar que `prompt --wait` exige cambio de estado en 5 segundos o devuelve `agent_prompt_stalled`.
- [x] Probar que `wait` por defecto acepta `idle`, `done` o `blocked`.
- [x] Probar que `start` confirma el agente esperado en el mismo panel antes de informar éxito.
- [x] Probar que los reportes atrasados no sobrescriben un estado más nuevo.
- [x] Probar que un reporte de una sesión anterior no se aplica a la sesión actual.
- [x] Probar que la salida del agente libera nombre, estado y comando de reanudación.
- [x] Probar que claude y codex aparecen con estados reales, no `working` permanente.
- [x] Probar que el aside y el CLI consumen el mismo estado ante la misma transición.
- [x] Registrar resultados y limpiar sesiones, tabs, paneles y archivos de laboratorio. (La carpeta `config` del lab queda: sesiones de herdr de la usuaria ejecutan el `omp.exe` de ahí por su `PATH`.)

## 7. Entrega

- [x] Verificar suites permanentes sin fallas.
- [x] Verificar funcionamiento en la ventana real con recursos propios.
- [x] Preservar sesiones, tabs y foco de la usuaria.
- [x] Actualizar documentación pública afectada.
- [x] Informar límites restantes y trabajo futuro.

## Resultados (2026-10-13)

Verificado en la ventana aislada (Tern 0.8.3) con los binarios reales: omp 18.10.3, Claude
Code 2.1.296 y Codex 0.159.1.

- omp, Claude y Codex: `start` listo en 4–6 s con sesión y `resume_argv`; turno en segundo
  plano → `done`, `✓` en el rail y `done.mp3`; foco explícito → `idle`; `list`/`get`/`read` no
  lo marcan visto; salida → nombre, estado y reanudación liberados.
- Preguntas (omp `ask`, Claude `AskUserQuestion`) y permisos reales (omp write, Codex fuera del
  workspace) → `blocked` con motivo, `?` y `request.mp3`; `prompt` devuelve `agent_blocked` sin
  tocar el panel; tras responder o aprobar, `done`.
- Diálogos de arranque de Codex (actualización, confianza de carpeta) → `agent_not_ready` con
  motivo, sin esperar el timeout.
- Suites: Node 167 tests (166 pasan, 1 salteado en Windows); Luau en la VM `total: PASS 585
  FAILURES 0`.
- omp 18.10.4, cambio de sesión en el mismo proceso (`/new` y `/resume` a la anterior): la
  sesión y `resume_argv` siguen al cambio y el `done` pendiente pasa a `idle`.
- omp 18.10.4 contra un proveedor falso local (503, agente aislado por `PI_CODING_AGENT_DIR`):
  8 fallos y luego respuesta → `working` sin cortes 19 s y `done`; con dos reintentos agotados
  (`agent_end` con `willContinue` en cada uno) → `working` 100 s y `blocked` con el error a los
  2,5 s; `prompt` → `agent_blocked`; escribir en el panel → `working` → `done`.
- `agent_prompt_stalled` se vio en vivo solo como síntoma de un bug ya
  corregido.

## Resultados (2026-10-14): detección como herdr

Cambio: el estado de Claude sale de la pantalla (manifests de herdr 2026.10.11.1 y el mismo
motor de reglas); Codex usa los hooks de herdr v9 con la pantalla para los bloqueos; omp sigue
con su extensión. Un loop del daemon lee pantalla y proceso de cada panel con agente, también
los abiertos a mano. Los sonidos los toca el daemon, con la demora de 1 s de herdr. Desvíos y
costos: `research/herdr-agent-detection.md` §9.

Verificado en una ventana aislada (Tern 0.8.3, Claude Code 2.1.296, Codex 0.159.1,
omp 18.10.4):

- Claude abierto a mano: `unknown` → `idle` a los ~3,7 s; un turno → `working` → `done` y
  `done.mp3` ~1 s después; `AskUserQuestion` → `blocked` (`live_blocked_form`) y
  `request.mp3`; permiso de Bash en modo manual → `blocked` (`bash_permission_prompt`) y
  `request.mp3`; aprobar → `working` → `done`; enfocar la tab → `idle`; `/exit` → la entrada
  se va en ~1,4 s.
- Claude por `start`: listo en 10 s con sesión y `resume_argv`; una pregunta → `blocked` con
  el texto de la pregunta (pista del hook), `request.mp3` a 1 s; responder → `done`,
  `done.mp3` a 1 s.
- Codex por `start` (CODEX_HOME de laboratorio): confianza de carpeta →
  `agent_not_ready: trust_directory` en 5 s; sandbox → `blocked`; listo sin `done` falso;
  turno por hooks → `done`; aprobación fuera del workspace → `blocked` con el motivo del hook
  y `request.mp3`; rechazarla → `working` → `done`.
- omp: con perfil nuevo, `start` → `agent_not_ready: omp_setup_wizard` (antes `agent_started`
  dentro del asistente); salir del asistente → listo sin `done`; `/exit` y otro `start` en el
  mismo panel → `agent_started` (antes `agent_pane_busy`); omp a mano y `/exit` → la entrada
  nativa se va.
- Costo con un Claude en reposo, 30 s: 22 `capture`, 10 `process`, 13 `ls` (descubrimiento) y
  un `tern events` vivo; un spawn ronda 200 ms.
- Suites: Node 212 pasan (1 salteado en Windows); Luau 569 sin fallas offline y en la
  ventana; `tern.log` sin errores de `workspaces-sidebar`. El runner `ws-tests` pasó su
  presupuesto dos veces, en pasos que este cambio no toca: `group` con la máquina cargada
  (corrida repetida: 1 ms) y `live`, que corre sin fixture.

