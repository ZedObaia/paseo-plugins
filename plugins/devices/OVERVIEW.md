Devices puts iOS simulators and Android emulators inside Paseo, as many per workspace as you need,
with a live view you can tap, swipe and type into from desktop or phone, the settings a tester
flips, and an agent-device command line your agents use to drive the same devices.

Open **Device** with the phone button in a workspace's header, which shows the device's name, or
how many it has, from the Explorer's + menu beside Files and Changes, or with Command Center,
"Open device", and pick a device. It opens next to the agent, so you can watch both. On a phone or a
narrow window it opens as a workspace tab, and on a phone the header button is the way to it. The
workspace's own + menu opens it as a tab anywhere. In Paseo's phone app a one-finger swipe sideways
moves Paseo's own panels, so swipe sideways on the device with two fingers.

Other plugins in the app can see which workspaces have a running device; the status sidebar shows
a phone on them.

To test on several platforms or screen sizes, add more devices from the panel's **Add device**; they
all run at once and the panel switches between them, or shows them all side by side with the grid
button. A device stays with its workspace: another workspace sees it as in use and has to take it
over explicitly, or press **New copy** to get its own simulator (same model and iOS version) or
another instance of the same emulator, so parallel workspaces each test on their own. A device that
leaves the host, like an unplugged phone, stays with its workspace as a missing device until it
returns or you release it.

On desktop and the web, click the device's screen and type: the keyboard goes to the device until
you press Escape. The sliders button opens the device's settings: light or dark appearance, text
size, Increase Contrast on iOS or airplane mode on Android, a simulated location, a link or deep
link to open, and grant or deny an app's permissions; on iOS, also a test push notification. Each
shows what the device reports after a change. **Attach Device screen** in the composer's + menu
attaches a running device's screen to your message, so an agent sees what you see. On a phone, a
device button above an agent's composer shows the workspace's device without leaving the chat.

Agents can drive a workspace's devices with the
[agent-device](https://github.com/callstack/agent-device) command line: accessibility snapshots,
taps, typing, app launches and screenshots. Each agent is told about the command in a short
paragraph, instead of loading agent-device's 59 MCP tools into every chat, and its device actions
show up in the chat as plain rows like "Tapped @e12" or "Took a screenshot" with the picture. Agent
tools are off until you turn them on, once for every device, with **Set up agent tools** in a Device
panel, which first explains what agent-device will install on each kind of device; you turn them off
again in the plugin's settings, **Agent tools**. Agents started after that get the command, and it
only reaches their workspace's devices, one at a time: they switch between them with a picker tool.
When a device is released, taken over or deleted, the command stops reaching it and moves to another
of the workspace's devices, if there is one; an emulator that is off can't be driven until it is
turned on. Agents can also add a free simulator or emulator themselves, one no other workspace
holds: it joins the workspace, as if you had added it in the panel, and is turned on if it's off. A
USB phone is only driven once you add it to the workspace yourself.

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

Emulators started here run headless, with their control port bound to localhost and protected by a
token. The iOS live view runs serve-sim in a helper process that listens only on a Unix socket in a
folder only your user can open. It has no network port, so web pages and other machines can't reach
it. The helper stops about 30 seconds after the last panel showing a simulator closes, and when the
plugin stops. Agents reach the plugin's picker through a small helper over another such Unix socket:
it lists the host's simulators and emulators, switches the agent's workspace between its own
devices, and gives a free simulator or emulator to it, nothing else. Each workspace's agent-device
command refuses to run while agent tools are off or the workspace has no device. Device settings run
simctl and adb with arguments the plugin checks; links and app names reach the device's shell only
quoted.

Frames and input travel between the host and your Paseo apps. What agents read through the device
command, including screenshots and screen text, is sent to the agent's model provider like any other
tool result. So are the names and states of the host's simulators and emulators, and which workspace
holds each, when an agent lists them, and an attached device screen when the agent opens it.
Attached screens are PNG files saved in the plugin's data folder on the host and deleted after a
day; the chat's screenshot pictures are made on the host from the files agents saved.

The first time an agent drives a device, agent-device installs its helpers on it: an XCTest runner
app it builds locally with Xcode for iOS, and two helper apps it ships with for Android (one reads
the screen's layout, one is a keyboard for typing). This only happens once you turned agent tools
on; turning them off doesn't remove helpers already installed. Nothing is downloaded while the
plugin runs.

The picture is a stream of still frames, several per second, not video.
