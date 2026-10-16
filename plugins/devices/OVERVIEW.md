Devices puts iOS simulators and Android emulators inside Paseo, one per workspace, with a live
view you can tap, swipe and type into from desktop or phone, and tools your agents use to drive
the same device.

Open a workspace's **Device** panel (or Command Center, "Open device") and pick a device. It stays
with that workspace: another workspace sees it as in use and has to take it over explicitly, or
press **New copy** to get its own simulator (same model and iOS version) or another instance of
the same emulator. Several devices run at once, so parallel workspaces each test on their own.

Agents started in a workspace that has a device get [agent-device](https://github.com/callstack/agent-device)
tools for it: accessibility snapshots, taps, typing, app launches and screenshots. They only reach
that workspace's device. When it is released, taken over or deleted, their device tools stop
working; an emulator that is off can't be driven until it is turned on. Assign the device before
starting the agent.

The **Devices** screen lists every simulator and emulator on the host, which workspace holds it,
and turns them on or off. Devices made with New copy can be deleted there. An emulator copy runs
read-only, so it keeps nothing once it stops. When a workspace is archived, its device is released
and a copy made for it is turned off; a simulator copy keeps its data until you delete it.

## Requirements

- iOS: a Mac with Apple silicon and Xcode. The live view uses
  [serve-sim](https://github.com/EvanBacon/serve-sim), which needs Simulator.app (the plugin keeps
  it running hidden) and, when Paseo runs as the desktop app, Node.js 20 or newer in PATH.
- Android: the Android SDK (adb, and the emulator package for AVDs). USB devices work too, at
  about one frame a second, and can't be turned on or off from here.
- Agent tools run on the daemon's Node.js, which needs to be 22.12 or newer; the desktop app's
  built-in runtime is.

## Security, data and installs

Emulators started here run headless, with their control port bound to localhost and protected by
a token. The iOS live view runs a serve-sim helper per simulator on localhost. The helper has no
authentication and accepts requests from any web page, so while it runs a page open in a browser
on that Mac could watch the simulator or tap on it. A helper stops within a minute after the last panel
showing its simulator closes.

Frames and input travel between the host and your Paseo apps. What agents read through the device
tools, including screenshots and screen text, is sent to the agent's model provider like any other
tool result.

The first time an agent drives a device, agent-device installs its helper on it: an XCTest runner
app it builds locally with Xcode for iOS, and two helper apps it ships with for Android. Nothing is
downloaded while the plugin runs.

The picture is a stream of still frames, several per second, not video.
