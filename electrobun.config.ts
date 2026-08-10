import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "VexWave",
		identifier: "app.vexwave",
		version: "0.1.2",
	},
	build: {
		// Vite builds to dist/, we copy from there
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/assets": "views/mainview/assets",
		},
		// Ignore Vite output in watch mode — HMR handles view rebuilds separately
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: true,
			icon: "assets/vex-logo.ico",
		},
	},
	scripts: {
		// electrobun's own attempt at stamping the icon onto the bundle's exes is
		// dead code in its compiled CLI, and the failure is swallowed. The hook
		// redoes it at the same point, before the bundle is tarred.
		postBuild: "scripts/stamp-win-icons.ts",
	},
} satisfies ElectrobunConfig;
