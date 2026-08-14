<div align="center">

<img src="assets/vex-logo.png" alt="VexWave" width="112">

# VexWave

**A desktop music player for the server you already own.**

<a href="https://framework.blackboard.sh/electrobun/"><img alt="Electrobun" src="https://img.shields.io/badge/Electrobun-8B3DEE?style=flat-square"></a>
<a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/Bun-A231FF?style=flat-square"></a>
<a href="https://react.dev"><img alt="React" src="https://img.shields.io/badge/React-6C3BD1?style=flat-square"></a>
<a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-41188F?style=flat-square"></a>

<br>

<a href="https://vexwave.github.io/"><img alt="vexwave.github.io" src="https://img.shields.io/badge/See_more-vexwave.github.io-8B3DEE?style=for-the-badge&labelColor=1A1024"></a>

<img src="assets/library.png" alt="The VexWave library, with a track playing" width="880">

</div>

## Features

| Feature | What it does |
| --- | --- |
| **Your library, from your server** | Sign in with host, port and credentials. No folder to scan, and search filters as you type. |
| **Playlists and artists** | Drag tracks into order, set cover art, play any playlist or artist as its own queue. As many artists per track as a song needs. |
| **Shuffle worth leaving on** | Every track gets its turn before any repeats, and Previous walks back through what actually played. |
| **Drop in local files** | Drag audio onto the window. VexWave reads the tags, shows you what it found, and uploads. |
| **Import from a link** | A YouTube or SoundCloud URL becomes a real track, with the creator suggested as an artist. |
| **Discover** | Search YouTube and SoundCloud in-app and download a hit into your library. |
| **Edit anything** | Title, cover, credits or delete, straight from the row. |
| **Ten-band equalizer** | Sits in the playback graph, so a change is heard on the track already playing. |
| **Discord Rich Presence** | Put what you're listening to on your profile. |

## Installation

> [!IMPORTANT]
> VexWave is the client half only. Every track streams from a server you run, so set one up first:
> **[VexWave/vex-backend](https://github.com/VexWave/vex-backend)**.

### From a release

Download `VexWave-Setup.exe` from the **[latest release](https://github.com/VexWave/vex-app/releases/latest)**
and run it. Windows x64, self-contained.

> [!NOTE]
> First launch downloads yt-dlp, ffmpeg and deno before showing the login screen.

### From source

Needs **[Bun](https://bun.sh) 1.3+**. No npm, no node.

```sh
git clone https://github.com/VexWave/vex-app.git
cd vex-app
bun install
```

| Command | What it does |
| --- | --- |
| `bun run dev:hmr` | Develop, with Vite HMR on 5173 |
| `bun run start` | Run from bundled assets |
| `bun run build:installer:stable` | Build `installers/VexWave-Setup.exe` |
