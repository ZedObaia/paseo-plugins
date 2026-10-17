Devices puts iOS simulators and Android emulators inside Paseo, one per workspace, with a live
view you can tap, swipe and type into from desktop or phone, and tools your agents use to drive
the same device.

Open **Device** with the phone button in a workspace's header, which shows the device's name once
the workspace has one, from the Explorer's + menu beside Files and Changes, or with Command Center,
"Open device", and pick a device. It opens next to the agent, so you can watch both. On a phone or a
narrow window it opens as a workspace tab, and on a phone the header button is the way to it. The
workspace's own + menu opens it as a tab anywhere.

The device stays with that workspace: another workspace sees it as in use and has to take it over
explicitly, or press **New copy** to get its own simulator (same model and iOS version) or another
instance of the same emulator. Several devices run at once, so parallel workspaces each test on
their own.

Agents can drive a workspace's device with [agent-device](https://github.com/callstack/agent-device)
tools: accessibility snapshots, taps, typing, app launches and screenshots. Agent tools are off
until you allow them on a device from its panel, which first explains what agent-device will
install there. Agents started in the workspace after that get the tools, and they only reach that
workspace's device. When it is released, taken over or deleted, their device tools stop working;
an emulator that is off can't be driven until it is turned on.

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
a token. The iOS live view runs serve-sim in a helper process that listens only on a Unix socket in
a folder only your user can open. It has no network port, so web pages and other machines can't
reach it. The helper stops about 30 seconds after the last panel showing a simulator closes, and
when the plugin stops.

Frames and input travel between the host and your Paseo apps. What agents read through the device
tools, including screenshots and screen text, is sent to the agent's model provider like any other
tool result.

The first time an agent drives a device, agent-device installs its helpers on it: an XCTest runner
app it builds locally with Xcode for iOS, and two helper apps it ships with for Android (one reads
the screen's layout, one is a keyboard for typing). This only happens on a device you allowed agent
tools on; turning them off doesn't remove helpers already installed. Nothing is downloaded while
the plugin runs.

The picture is a stream of still frames, several per second, not video.
