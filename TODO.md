# TODO

## Status

Milestone 1 (0.1.0, local commit, not pushed): the nodes of a MySensors
network through an Ethernet or MQTT gateway; relays and dimmers declared safe
commanded; turning off never held. Never tested with a real gateway nor a
real node: built from the published serial protocol 2.x and pymysensors
0.26.0, tested against fake gateways (TCP and MQTT broker) on real local
sockets.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-mysensors:0.1.0`):
  the first patch release gives 0.1.1. No `keywords` nor `countries` in the
  manifest (MySensors is worldwide).
- **Reference**: pymysensors 0.26.0 (MIT, theolind, the library of Home
  Assistant's `mysensors`), read at commit 73a74a9, license checked in its
  `LICENSE`; the MySensors serial protocol 2.x published on mysensors.org.
  Ported, not copied; credited in `THIRD_PARTY_NOTICES.md`, shipped in the
  image. Neighbours read only: gladys-qbus (MQTT client and packet guard,
  relays declared safe), gladys-airtouch5 (/data store, stops, clocks),
  gladys-rtl433 and gladys-mqtt-discovery (sensors over MQTT).
- **Gateways**: Ethernet gateway as a TCP client of port 5003 (as pymysensors;
  Gladys never listens, so no inbound connection to bound), or MQTT gateway
  through the broker of the user (plain TCP; no TLS in v1). **No serial/USB
  gateway** (Louis's rule for this module).
- **One link at a time**, a new one only once the previous one is closed;
  waits of 1 s, 2 s, 5 s, 10 s, 30 s, then 1 min after a failure (reset after
  a link that lived a minute); a stop clicked meanwhile tries at once (a
  click, never a loop).
- **Alive** only on a valid MySensors message on this link (the version of
  the gateway is asked when the link opens and a minute after the last
  answer); over TCP a link silent for more than 150 s is closed. Over MQTT a
  silent gateway is shown as such (the broker link stays).
- **Bounds**: a line over 256 bytes is skipped as it comes (never buffered);
  MQTT 5 `maximumPacketSize` 4 KB and the PacketGuard of gladys-qbus cut a
  larger packet before it is read (also in 3.1.1); a payload over 200
  characters, a non-printable one or a topic outside the prefix is dropped;
  200 messages per second at most (token bucket); 64 children per node.
  Strict numbers (no leading zero, no sign where none is expected);
  node ids 0-254 (255 is the broadcast/unassigned id), child ids 0-254.
- **Identity**: MySensors gives no serial number nor MAC: the node id is the
  identity of a node (as in pymysensors and every MySensors controller), the
  external ids `ext:<selector>:node:<id>` and `...:<child>-<kind>` are
  frozen. One integration = one MySensors network. A child presented again
  as another type refuses non-protective commands until the device is
  updated; its values feed only the kinds of its new presentation.
- **Relays and dimmers declared safe only** (Louis's rule, model gladys-qbus):
  `S_BINARY` and `S_DIMMER` children listed in `safe_actuators` (`node:child`,
  200 entries at most, invalid ones in the status) become `switch/binary` or
  `light/binary` + `light/brightness`; the others are `unknown/binary` (and
  `unknown/integer` 0-100) read only. Heaters (`S_HEATER`) and sprinklers
  (`S_SPRINKLER`) are always read only. A feature created before the list
  changed is kept (never a lost feature); turning on through it is then
  refused ("not declared safe"), turning off still leaves.
- **Commands**: sent with the echo flag (ack=1); confirmed only by the exact
  echo (node, child, type, payload) or by the report of the node; else "sent,
  without confirmation" after 3.5 s. MySensors has no read-back: the echo
  proves the node received the command, so only the reports of the node
  (ack 0) are published as states, never an echo. Nothing is queued: a command leaves now
  (no await between its checks and its send) or is refused ("nothing sent").
  Brightness: an integer 0-100; 0 is an off (V_STATUS 0).
- **Stops** (off, brightness 0): independent of the declaration, the
  configuration, /data and the gateway being verified; sent at once on the
  open link (otherwise the link is opened at once and all kept stops are
  written first); resent after 1.5 s, 5 s, 20 s, 1 min; abandoned (status)
  after 5 effective sends without echo; a new click gives the whole budget
  again. Only a write on an open link counts as a send. Confirmed by an echo
  or a report of 0 arriving after a send of this process. Kept in /data
  (route, node, child, count; an unreadable count is 0; no age limit); sent
  again after a restart before getConfig() through the route of /data (TCP,
  or MQTT without credentials: no secret in /data). A newer command of the
  target that actually left cancels it.
- **Freshness**: values published when they come (no `created_at`), measurements
  of one feature spaced by 5 s, a value waiting more than 2 min dropped; a
  reconnection to Gladys clears the publication caches and republishes
  nothing old; a device created gets the values of the last 2 min only;
  retained MQTT messages are ignored.
- **Units**: the nodes are answered "M" (metric) to I_CONFIG: °C, hPa (as the
  official pressure sketch), cm (distance sketch), lux (V_LEVEL of
  S_LIGHT_LEVEL), % (soil moisture). V_TRIPPED of a door: 1 = open in
  MySensors, 0 in Gladys (opening-sensor 1 = closed). V_WATT signed.
- **Not offered in v1**: covers (S_COVER), thermostats and setpoints (S_HVAC,
  S_HEATER setpoints), RGB lights, V_KWH (an index needs the guard of
  gladys-p1-monitor), V_LIGHT_LEVEL in % (no unit of the core), wind, rain,
  weight, dust and air quality (units not fixed by the protocol), scene
  controllers, locks, IR, OTA firmware (STREAM), requests of a node for a
  value the controller keeps (REQ).
- **Node ids**: I_ID_REQUEST answered with the lowest id unused (heard,
  created in Gladys, handed out), saved in /data BEFORE it is sent (save
  failed: nothing given); an unused id given again after 5 min; 10 unused at
  most; option `assign_node_ids` (on by default).
- **Answers to the nodes**: I_CONFIG "M", I_TIME (local time, seconds), at
  most one of each per node every 2 s; I_DISCOVER broadcast when the gateway
  is ready; a Scan asks the known silent nodes to present themselves
  (I_PRESENTATION, 250 ms apart, 50 at most, once a minute).
- **Refused MQTT credentials** (CONNACK 4, 5, 134, 135, 138, or a CONNECT
  with credentials left unanswered twice in a row): no try before 15 min,
  1 h, 6 h, then 24 h; persisted in /data with a salted 6-bit mark of the
  refused pair (never the password, never a usable hash). After a restart
  the wait goes on only if the mark matches (a new password colliding with
  the mark, 1 in 64, waits for the next spaced try). Saving the
  configuration or the test button always tries at once. A broker answering
  1 or 132 is used in MQTT 3.1.1 (status).
- **getConfig()** failing in `connected`: tried again after 5 s, 15 s, then
  every minute, for life, with the status.
- **/data** (`/data/mysensors-state.json`, 0600): opened without following a
  link and without waiting (FIFO refused), 64 KB at most, every load and save
  bounded (2 s); unreadable at start: read again every 10 s, one read at a
  time, never written over, what was clicked meanwhile kept.
- **Clock**: monotonic for every wait and decision; the wall clock only for
  /data (ids handed out, next try after refused credentials).

## Next

- Ethernet gateways in client mode (`MY_CONTROLLER_IP_ADDRESS`: the gateway
  connects to the controller): Gladys would listen, with bounds on message
  size, connections, duration and the allowed source address (lot 20 rule
  for inbound listening). Not in v1: the default gateway is a server, as
  pymysensors expects.

- Covers (S_COVER: up/down/stop and position), with stop never held.
- V_KWH as an index with the guard of gladys-p1-monitor.
- TLS to the broker, with a pinned certificate.
- RGB lights; thermostats behind an off-by-default option.
- Test with a real gateway (forum).
