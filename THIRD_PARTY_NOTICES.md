# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## pymysensors

<https://github.com/theolind/pymysensors> (package `pymysensors`, version
0.26.0 of 2025-07-17, read at commit 73a74a9 of 2026-11-02), by Theodor
Lindquist and contributors, the library of the Home Assistant `mysensors`
integration. MIT License (`LICENSE` of the repository, reproduced below).

Ported: the layout of a message of the MySensors serial protocol 2.x
(`node;child;command;ack;type;payload`, `mysensors/message.py`), its MQTT form
(`<prefix>/node/child/command/ack/type`, `mysensors/gateway_mqtt.py`), the
numbers of the presentation, value and internal types (`mysensors/const_20.py`
to `const_22.py`), the TCP gateway as a client of port 5003 with its version
asked as a keepalive (`mysensors/gateway_tcp.py`), and the answers a
controller gives to the nodes: an id to a node that asks for one, the
configuration (metric), the time, and the discovery request when the gateway
is ready (`mysensors/handler.py`).

Changed: every field is checked (strict numbers in their ranges, a printable
payload of bounded length; a line or an MQTT packet over its bound is dropped
before it is read); a retained MQTT message is never taken for a value; the
commands are sent with the echo flag and confirmed only by the exact echo of
the node (or its report); the ids handed out are kept on disk before they are
given; nothing is persisted of the values; a relay or a dimmer is commanded
only when the user declared it safe; serial gateways are not supported.

The protocol itself is the "MySensors Serial Protocol (2.x)" published by the
MySensors project (<https://www.mysensors.org/download/serial_api_20>). This
integration is not affiliated with the MySensors project.

```
The MIT License (MIT)

Copyright (c) 2015 Theodor Lindquist

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## mqtt (mqtt.js)

<https://github.com/mqttjs/MQTT.js>, used as an npm dependency (not copied),
MIT License. The guard on the size of the packets (`src/mqtt.js`) comes from
the sibling integration gladys-qbus (Apache License 2.0, same author).
