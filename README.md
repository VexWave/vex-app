<div align="center">

<img src="assets/vex-logo.png" alt="VexWave" width="112">

# VexWave

**A desktop music player conntected to your server.**

<p>
  <a href="https://framework.blackboard.sh/electrobun/"><img alt="Electrobun" src="https://img.shields.io/badge/Electrobun-8B3DEE?style=flat-square"></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/Bun-A231FF?style=flat-square"></a>
  <a href="https://react.dev"><img alt="React" src="https://img.shields.io/badge/React-6C3BD1?style=flat-square"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-41188F?style=flat-square"></a>
</p>

<p>
  <a href="https://github.com/VexWave/vex-app/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/VexWave/vex-app/ci.yml?branch=main&label=build"></a>
  &nbsp;
  <a href="https://github.com/VexWave/vex-app/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/VexWave/vex-app?label=release&color=blue"></a>
  &nbsp;
  <a href="https://github.com/VexWave/vex-app/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/VexWave/vex-app/total?label=downloads&color=blue"></a>
</p>

<br>

<img src="assets/library.png" alt="The VexWave library, with a track playing" width="880">

</div>

<div align="right">

<a href="https://vexwave.github.io/"><img alt="vexwave.github.io" src="https://img.shields.io/badge/See_more-vexwave.github.io-8B3DEE?style=for-the-badge"></a>

</div>

## Features

| Feature | What it does |
| --- | --- |
| **Your library** | Sign in with your server's address and credentials. No folder to scan, and search filters as you type. |
| **Import from a link** | A YouTube or SoundCloud URL becomes a real track, with the creator suggested as an artist. |
| **Discover** | Search YouTube and SoundCloud in-app and load them into your library. |
| **Equalizer** | Ten sliders to shape the sound |
| **Effects** | Speed, drive and reverb, straight from the player bar. |
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
