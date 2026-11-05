## JusteReseau: Remote Volume

This module is for controlling the Remote Volume application. This allows you to control the volume of PCs in the network by Companion.

For this module to work, a helper application must be installed on all PCs that are to be remote-controlled. This helper application enables communication between the PC and the Companion instance.

You can download the latest release of the helper application, called [Remote Volume](https://github.com/ultimategmbh/remote-volume/releases/latest) from the UTS GitHub releases page. The link will always get you to the latest version.

- For Windows: Download and install the .exe file.
- For OSX: Download the corresponding .dmg file (x64 for Intel processors or ARM for Apple M Processors.), open the .dmg and drag&drop the app into your applications folder.
- For Linux: Download and install the .deb file

The module also works with the all-Rust rewrite of the helper application, [remote-volume](https://github.com/Justereseau/companion-remote-volume/releases/latest). Both speak the same WebSocket protocol on port 2501.

After the Remote Volume application is installed, make sure that the application is running in the background, to ensure that Companion can connect to the application.

In the module configuration, simply enter the IP address of the PC which is running the Remote Volume software and make sure that the 'port' setting in the module configuration matches the configured port in the Remote Volume application configuration window.

### API key

If you set an access token in the Remote Volume app (Settings > WebSocket), enter the same value in the **API key** field of the connection. The module sends it as a Bearer token in the connection header, and Companion keeps it in its secret store. Leave the field empty when the app has no token.

If the app refuses the key, the connection shows an authentication failure and does not retry until you change the settings.
