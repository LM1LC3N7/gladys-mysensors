# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for MySensors home-made sensor
networks: a Node.js service (Node 22+, ESM, no build step) that runs in its
own sandboxed Docker container, talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)
and to the MySensors gateway of the user: an Ethernet gateway (TCP 5003) or
an MQTT gateway through the broker of the user (`mqtt`, mqtt.js). Never a
serial gateway. Unofficial, not affiliated with the MySensors project.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/stops.test.js            # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run mutants                           # scripts/mutants.mjs, one at a time
FAKE_GATEWAY_DELAY=300 FAKE_BROKER_DELAY=700 npm test   # a slow network: must pass too
node scripts/cover.mjs cover.png          # regenerate the cover
npx github:GladysAssistant/integration-store .   # store admission checks
```

## Architecture

```
index.js           SDK wiring only
src/handlers.js    the SDK handlers -> MySensorsApp (shared with the tests)
src/app.js         link, messages, nodes, states, commands, stops, ids, status
src/protocol.js    the serial protocol 2.x: lines and MQTT topics (pure)
src/tcp.js         the Ethernet gateway: bounded lines
src/mqtt.js        mqtt.js over a TCP socket: packets bounded before they are read
src/model.js       nodes -> Gladys devices, kinds, commands (pure)
src/store.js       /data: route, stops, ids handed out, refused credentials
src/publisher.js   states within 300 per minute, fresh only
src/config.js      the manifest config_schema, normalized
src/i18n.js        runtime texts, English and French
scripts/mutants.mjs  the mutants the tests must kill
```

## Rules

- **External ids are forever**: `ext:<selector>:node:<id>`, features
  `<device>:<child>-<kind>` and `<device>:battery` (src/constants.js KIND).
- **Never a switch or a light** unless the user declared `node:child` safe;
  heaters and sprinklers never commanded. **Turning off is never held** (no
  option, declaration, configuration, /data or verified gateway needed).
- **Nothing queued**: a command leaves now or is refused; MQTT
  `queueQoSZero: false`, never retained.
- **Never a secret** in the logs, `/data`, a status or an error. The
  password is "kept by Gladys in its database, never shown again" (Gladys
  stores it in clear: never claim more, `test/manifest.test.js` checks it).
- **Untrusted input**: everything from the gateway is bounded and checked
  (lines, packets, payloads, numbers, rate) BEFORE it is used.
- **Clock**: monotonic for decisions; the wall clock only for /data.
- **Versions** belong to the Release workflow; **changelog** lines go under
  `## [Unreleased]`.
- **Texts** are bilingual (English and French), UTF-8 without BOM
  (`test/encoding.test.js`). Tests never touch the network beyond 127.0.0.1.
- **Tests and time**: never advance the virtual clock while a network
  exchange is on its way: wait for it in real time (`net`, `live`,
  `answer(..., { real })` of `test/helpers/app.js`), then advance the clock
  for the timers of the app. The suite must pass with
  `FAKE_GATEWAY_DELAY=300 FAKE_BROKER_DELAY=700`.
