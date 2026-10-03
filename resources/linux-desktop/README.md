# Linux desktop capture

Replay follows the focused window. It checks the window identity before and after capture. If focus changes, it discards that image. App exclusions come from the existing capture settings list.

## Desktop support

- X11: the existing native window reader and Electron capture path.
- GNOME 45–51 on Wayland: the bundled Off Grid AI Capture extension provides focused-window capture and keyboard input. Off Grid installs it after the user enables capture or registers a Voice shortcut. GNOME may require one sign-out and sign-in before the new extension can be enabled.
- KDE Plasma 6 on Wayland: the bundled kdotool queries the focused window; Spectacle captures it. Keyboard input uses the desktop Remote Desktop permission request.
- Sway and Hyprland: compositor commands provide the focused window; grim captures its bounds. Voice paste uses wtype. Global shortcut press and release use the Global Shortcuts portal when the desktop provides it.

The desktop must grant the required permissions. A desktop that does not provide these interfaces returns an error; the app does not save an unrelated screen as a replacement.

## Meeting recording

On Wayland, the ScreenCast portal lets the user choose the meeting window or screen. PipeWire supplies its video. On X11, ximagesrc records the detected meeting window, or the display at the cursor when no meeting window is found. PipeWire-Pulse or PulseAudio supplies system sound and microphone input. GStreamer writes the screen and microphone tracks separately; the existing meeting service combines them and stores the transcript.

## Runtime requirements

The Debian package declares Python GI, GStreamer, PipeWire, the desktop portal, and the desktop capture/input tools as dependencies. An AppImage uses the host's installed desktop packages. Its host needs:

- `/usr/bin/python3` with PyGObject and GStreamer introspection;
- GStreamer PipeWire, PulseAudio, x264, Opus, WAV, and Matroska elements;
- `xdg-desktop-portal` and a backend for the current desktop;
- `gnome-extensions` on GNOME, Spectacle on KDE, or grim on Sway/Hyprland;
- x11-utils (xprop and xwininfo) for X11 window details; xdotool for X11 paste, or wtype on Sway/Hyprland.

The release staging script downloads kdotool 0.3.0 from its upstream release and checks its pinned SHA-256. No new application settings store is used.

Native capture, meeting audio, permissions, and key delivery must be checked on the supported desktops. Passing the synthetic compositor contract tests does not verify the native desktop or hardware.
