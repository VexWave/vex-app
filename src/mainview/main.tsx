import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { watchDevicePixelRatio } from "@/lib/devicePixelRatio";
import "./index.css";
import App from "./App";

// Ahead of the first render: on a HiDPI display the stylesheet's `--dpr: 1`
// fallback would draw one frame of an off-grid now-playing ring.
watchDevicePixelRatio();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
