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
  echo (node, child, type, payload), never by a report of the node (review
  r1, M1); else "sent, without confirmation" after 3.5 s. MySensors has no read-back: the echo
  proves the node received the command, so only the reports of the node
  (ack 0) are published as states, never an echo. Nothing is queued: a command leaves now
  (no await between its checks and its send) or is refused ("nothing sent").
  Brightness: an integer 0-100; 0 is an off (V_STATUS 0).
- **Stops** (off, brightness 0): independent of the declaration, the
  configuration, /data and the gateway being verified; written at once on the
  open link (otherwise the link is opened at once and all kept stops are
  written first), each write followed by a version request. **A send counts
  only when proven** (review r1, B1): the gateway answered, on the same link,
  a version request written after the stop (TCP and MQTT keep the order), or
  the node echoed it; a write on a link that closes before (an ESP8266
  gateway with its client slot taken: accept then close) counts nothing, so
  such a stop is never abandoned and leaves on the next link. Resent after
  1.5 s, 5 s, 20 s, 1 min; abandoned (status) after 5 proven sends without
  echo; a new click gives the whole budget again. A resend due while the link
  is down follows the waits of the link (no connection without a click).
  Confirmed by an echo or a report of 0 after it left. Lifted, never sent
  again, by a newer command of the target that actually left, or by two
  reports of the node showing it on after it left, only when it was known off
  before the click: its last report said off and, if an on (or brightness)
  of Gladys left for it, a report came more than 3.5 s (the echo time) after
  that on; a sooner one may have crossed it (review r1 I1, r2 B1, r3 I1: on
  or unknown before is not a change made elsewhere; one V_STATUS report per
  change, the V_PERCENTAGE of a dimmer not counted). Unknown before: reports
  of on never lift it; it goes on until the node echoes it or reports it off
  (confirmed; an on made at the node afterwards is kept), else abandoned. An
  echo is never a state (never the state before a click, never settles an
  on, never republished). The note stays until the node reports the target off, a new
  click, or 10 min (review r3 M1). The status tells a stop kept (link down)
  from one written on the open link and not proven yet (review r3 M4). A
  send is proven by the answer to a version ask
  written after it: asks queued per link, each answer matched to the oldest
  one waiting, asks older than 10 s forgotten, unasked answers ignored and, for a
  minute after one, no answer proves a send (only an echo; status note):
  another controller of the gateway or a forged answer could otherwise pop
  an ask of Gladys; the proofs of the 10 s before such an answer are
  withdrawn (review r2 I1). **Residual limit** (review r3 M2): the protocol
  has no request id, so a forger on the network or the broker that answers
  each version ask of Gladys at once, while the gateway is away (never an
  unasked answer), makes 5 proofs and the stop is abandoned (status: read 5
  times by the gateway); accepted, such an attacker could as well send
  commands (docs, Security). Kept in
  /data (route, node, child, proven count; an unreadable count is 0; no age
  limit); sent again after a restart before getConfig() through the route of
  /data (TCP, or MQTT without credentials: no secret in /data).
- **Link attempts** (review r1, B2, I2): a configuration saved during a slow
  attempt to another gateway opens the new link as soon as the stale attempt
  ends (whatever its outcome); an attempt to the same gateway is kept. A
  click (stop) during an attempt that fails tries once more at once, then the
  waits resume.
- **Presented type**: kept in memory only; after a restart the declaration is
  the guard until the node presents itself again (review r1, M3, documented).
- **I_DISCOVER** when the gateway says it is ready: once a minute at most
  (review r1, M2).
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
  most one of each per node every 2 s; I_DISCOVER broadcast (once a minute at most) when the gateway
  is ready; a Scan asks the known silent nodes to present themselves
  (I_PRESENTATION, 250 ms apart, 50 at most, once a minute).
- **Refused MQTT credentials** (CONNACK 4, 5, 134, 135, 138, or a CONNECT
  with credentials left unanswered twice in a row): no try before 15 min,
  1 h, 6 h, then 24 h; persisted in /data with a salted 6-bit mark of the
  refused pair (never the password, never a usable hash). After a restart
  one try at once (a password changed meanwhile is always tried, review r2
  I2); if refused again, the count goes on when the mark matches (a longer
  wait), else starts over; no wait is ever armed from the file alone. A
  configuration read again on a reconnection to Gladys with another pair
  than the refused one is tried at once; the same pair keeps its wait (no
  try). /data read late at start (past its 2 s bound): what this process
  settled meanwhile (a connection accepted, a refusal, new credentials, the
  test button) wins over the refusal of the file, which is then written
  over; nothing settled yet, the file is compared with the configuration
  when it is read (review r3 M3). Saving the configuration or the test
  button always tries at once. A broker answering
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
