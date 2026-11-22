Devices puts iOS simulators and Android emulators inside Paseo, as many per workspace as you
need, with a live view you can tap, swipe and type into from desktop or phone, and tools your
agents use to drive the same devices.

Open **Device** with the phone button in a workspace's header, which shows the device's name, or
how many it has, from the Explorer's + menu beside Files and Changes, or with Command Center,
"Open device", and pick a device. It opens next to the agent, so you can watch both. On a phone or a
narrow window it opens as a workspace tab, and on a phone the header button is the way to it. The
workspace's own + menu opens it as a tab anywhere. In Paseo's phone app a one-finger swipe sideways
moves Paseo's own panels, so swipe sideways on the device with two fingers.

Other plugins in the app can see which workspaces have a running device; the status sidebar shows
a phone on them.

To test on several platforms or screen sizes, add more devices from the panel's **Add device**; they
all run at once and the panel switches between them, one live view at a time. A device stays with
its workspace: another workspace sees it as in use and has to take it over explicitly, or press
**New copy** to get its own simulator (same model and iOS version) or another instance of the same
emulator, so parallel workspaces each test on their own. A device that leaves the host, like an
unplugged phone, stays with its workspace as a missing device until it returns or you release it.

Agents can drive a workspace's devices with
[agent-device](https://github.com/callstack/agent-device) tools: accessibility snapshots, taps,
typing, app launches and screenshots. Agent tools are off until you allow them on a device from its
panel, which first explains what agent-device will install there. Agents started in the workspace
after that get the tools, and they only reach that workspace's devices you allowed, one at a time:
they switch between them with a picker tool. When a device is released, taken over or deleted, their
device tools stop reaching it and move to another of the workspace's devices you allowed, if there
is one; an emulator that is off can't be driven until it is turned on. Agents can also add a device
themselves, but only one you allowed agents on that no other workspace holds: it joins the
workspace, as if you had added it in the panel, and a simulator or emulator that is off is turned
on.

The **Devices** screen lists every simulator and emulator on the host, which workspace holds it,
and turns them on or off. Devices made with New copy can be deleted there. An emulator copy runs
read-only, so it keeps nothing once it stops. When a workspace is archived, its devices are released
and copies made for it are turned off; a simulator copy keeps its data until you delete it.

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
when the plugin stops. Agents reach the plugin's picker through a small helper over another such
Unix socket: it lists the devices you allowed agents on, switches the agent's workspace between
its own, and gives a free one to it, nothing else.

Frames and input travel between the host and your Paseo apps. What agents read through the device
tools, including screenshots and screen text, is sent to the agent's model provider like any other
tool result. So are the names and states of the devices you allowed agents on, and which workspace
holds each, when an agent lists them.

The first time an agent drives a device, agent-device installs its helpers on it: an XCTest runner
app it builds locally with Xcode for iOS, and two helper apps it ships with for Android (one reads
the screen's layout, one is a keyboard for typing). This only happens on a device you allowed agent
tools on; turning them off doesn't remove helpers already installed. Nothing is downloaded while
the plugin runs.

The picture is a stream of still frames, several per second, not video.
