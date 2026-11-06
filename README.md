# gladys-mysensors

Unofficial [Gladys Assistant](https://gladysassistant.com) external
integration for **MySensors** home-made sensor networks: the nodes heard
through an Ethernet gateway (TCP 5003) or an MQTT gateway become Gladys
devices (temperature, humidity, pressure, doors, motion, smoke, leaks, light,
power, battery...); relays and dimmers become switches and lights only when
the user declares them safe. Turning off needs no option nor declaration.
Local only, no serial (USB) gateway.

Never tested with a real device. Not affiliated with the MySensors project.

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Protocol logic ported from [pymysensors](https://github.com/theolind/pymysensors)
  (MIT): see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- Changes: [CHANGELOG.md](CHANGELOG.md); decisions and next steps:
  [TODO.md](TODO.md)

## Development

```bash
npm install
npm run format:check
npm run lint
npm test
npm audit --omit=dev
npm run mutants          # the mutants of scripts/mutants.mjs, one at a time
npx --yes github:GladysAssistant/integration-store .
```

`src/app.js` holds the integration (link, nodes, values, commands, stops,
ids, status), `src/protocol.js` the serial protocol, `src/tcp.js` and
`src/mqtt.js` the two gateways, `src/model.js` the devices,
`src/handlers.js` the SDK wiring shared with the tests (against the SDK's
fake Gladys and fake gateways on real local sockets, `test/helpers/`). See
[CLAUDE.md](CLAUDE.md) for the project rules.

## License

Apache License 2.0, see [LICENSE](LICENSE).
