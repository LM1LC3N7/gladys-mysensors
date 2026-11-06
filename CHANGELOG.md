# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: the nodes of a MySensors network heard through an Ethernet
  gateway (TCP, port 5003) or an MQTT gateway and the broker of the user, one
  connection at a time: temperature, humidity, pressure, door, motion, smoke,
  leak, vibration, light level, soil moisture, power, voltage, current, UV,
  distance, pH, ORP and battery, one Gladys device per node.
- Relays and dimmers declared safe by the user (`node:child`) become switches
  and lights, confirmed by the echo of the node; the others are read only.
  Turning off is never held: sent at once, sent again without echo (5 sends
  proven read by the gateway; a write on a connection closed at once never
  counts), lifted when the node, known off before, is turned on again in
  place (reported twice),
  kept on disk until the node confirms it, even across a restart.
- Node ids handed out to the nodes that ask for one, kept on disk first.
- Bounds on everything that comes in: lines of 256 bytes, MQTT packets of
  4 KB (cut before they are read), 200 messages per second; retained MQTT
  messages never taken for values.
- Refused MQTT credentials: next tries spaced (15 min to 24 h), across
  restarts; new credentials or the test button try at once.
