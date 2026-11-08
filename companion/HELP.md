## JusteReseau: Remote Volume

This module controls the audio volume of computers on your network from Companion.

It needs a small helper app, **Remote Volume**, running on each computer you want to control. Companion connects to it over the network (WebSocket, port 2501 by default).

### Install the helper app

Download it from the [latest Remote Volume release](https://github.com/Justereseau/companion-remote-volume/releases/latest). It is a single program, one archive per OS, with no installer:

- Windows: `remote-volume-windows-x64.zip`
- macOS (Apple silicon): `remote-volume-macos-arm64.tar.gz`. The program is not signed: if macOS blocks it, run `xattr -d com.apple.quarantine remote-volume` once.
- Linux (PulseAudio or PipeWire): `remote-volume-linux-x64.tar.gz`. The `libpulse0` package must be installed.

Unpack the archive and run `remote-volume`. It runs in a terminal window until you stop it with Ctrl+C. The app does not start with the computer by itself yet; see [the app's readme](https://github.com/Justereseau/companion-remote-volume#installation) for how to start it with your OS (Task Scheduler, a `launchd` agent, a `systemd` user service).

On Windows, the firewall may ask whether Remote Volume can use the network the first time it starts. Allow it, at least on private networks, or Companion cannot connect from another computer.

### Settings

The settings of the helper app are a web page on the computer running it: open `http://127.0.0.1:2502/` there (or start the app with `--open`). That page sets the port, whether other computers may connect, an optional access token, and polling for changes made outside the app.

In the module configuration, enter the IP address of that computer (`127.0.0.1` when Companion runs on the same one) and the same port as in the app's settings.

The original [UTS Remote Volume](https://github.com/ultimategmbh/remote-volume) app still works for volume and mute (protocol v1), but not for the newer features such as per-app volume.

### API key

If you set an access token in the Remote Volume settings page (section **Access**), enter the same value in the **API key** field of the connection. The module sends it as a Bearer token in the connection header, and Companion keeps it in its secret store. Leave the field empty when the app has no token.

If the app refuses the key, the connection shows an authentication failure and does not retry until you change the settings.

### Adjust Volume

`Adjust Volume` and `App: Adjust Volume` raise or lower the volume by a step in percentage points: a positive step raises it, a negative one lowers it (`5`, `-5`). The step accepts variables, so one button or knob can use a step set elsewhere. A step of 100 or more sets the volume to 100, and -100 or less sets it to 0.

They replace the former Increase Volume and Decrease Volume actions; buttons that used those are converted when the module updates.

### Media keys

`Media Key` presses Play / Pause, Next track or Previous track on the computer, like its keyboard's media keys: the computer sends it to the media player it picks (on Windows, the one shown in the volume flyout; on Linux, the player that is playing, else a paused one). The presets (category _Media_) have one button for each key.

It needs a Remote Volume app with media keys (Windows or Linux; not macOS yet). Otherwise the module sends nothing and logs it once. On Linux, `No media player found` is logged when no player is running.

### Function keys

`Function Key` presses F1 to F24 on the computer, like its keyboard: the focused window gets the key, or the app that uses it as a global hotkey. F13 to F24 are not on most keyboards, which makes them good hotkeys for other apps (OBS, Discord, ...).

The presets (category _Function keys_) have one button for each key.

It needs a Remote Volume app with function keys: Windows, or Linux in an X11 session with `xdotool` installed (not macOS yet). Otherwise the module sends nothing and logs it once.

### Backend version

The connection's settings page shows the version of the Remote Volume app it is connected to, and the variable `backend_version` holds the same version. Use them to follow an update of the app from Companion. If the version changes while the settings page is open, reopen the page to see the new one.

The page shows `Not connected` while there is no connection, and `Unknown` for a Remote Volume app too old to report its version. The variable is empty in both cases.

### Per-app volume and mute

With a Remote Volume app that supports it (protocol v2, Windows and Linux), the module can control the volume and mute of each app playing audio:

- **Actions:** `App: Set Volume`, `App: Adjust Volume`, `App: Set Mute` (mute, unmute or toggle).
- **Feedbacks:** `App: Muted`, and `App: Running` to grey out a button while the app plays nothing.
- **Variables:** `apps` (the names of the apps playing audio), and `app_<id>_volume` / `app_<id>_muted` for each of them.
- **Presets**, for each app playing audio: a mute button (category _Apps: Mute_, red while muted) and a volume knob showing the volume (category _Apps: Volume_; turn to change the volume, press to mute).

An app is picked by its **id**: the program file name in lowercase, without `.exe` (`spotify`, `chrome`, `discord`). The dropdown lists the apps playing audio right now, and you can type an id for an app that is not running yet. Tick **Pick the app with a variable** to enter the app as text instead, with variables (e.g. `$(custom:app)`): an id or a display name. All the sessions of a program (browser tabs, helper processes) count as one app. On Windows, the system sounds (notifications, alerts) are the app `system`.

If the app is not running, Remote Volume answers `App not found` and the log shows it. With an older Remote Volume app, on macOS, or when per-app audio is turned off in the app's settings, the module sends nothing and logs it once.

Privacy: the module, like any client of the Remote Volume app, sees which apps are playing audio. Turn **Per-app volume and mute** off in the app's settings page if that is a concern.
