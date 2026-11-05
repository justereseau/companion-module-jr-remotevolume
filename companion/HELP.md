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
