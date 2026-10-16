Devices puts iOS simulators and Android emulators inside Paseo, one per workspace, with a live
view you can tap, swipe and type into from desktop or phone, and tools your agents use to drive
the same device.

Open a workspace's **Device** panel (or ⌘K, "Open device") and pick a device. It stays with that
workspace: another workspace sees it as "in use" and has to take it over explicitly, or press
**New copy** to get its own simulator (same model and iOS version) or another instance of the
same emulator. Several devices run at once, so parallel workspaces each test on their own device.

Agents started in a workspace that has a device get agent-device's MCP tools for it: accessibility
snapshots, taps, typing, app launch and screenshots, locked to that workspace's device.

The **Devices** screen lists every simulator and emulator on the host, which workspace holds it,
and turns them on or off. Simulators and emulator instances created here can be deleted there.

Requirements: iOS needs a Mac with Xcode (Apple silicon; the live view uses serve-sim, which runs
Simulator.app hidden). Android needs the Android SDK (adb, and the emulator for AVDs); emulators
started here run headless with a localhost-only, token-protected control port. USB Android devices
work too, with a slower picture. The picture is a stream of still frames (several per second), not
video. Everything runs on the daemon host; frames and input go only between it and your Paseo apps.
