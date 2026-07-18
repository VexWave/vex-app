import { AlertCircle, Check, Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Logo } from "@/components/Logo";
import { Progress } from "@/components/ui/progress";
import { useBinaries } from "@/hooks/useBinaries";
import { formatMb } from "@/lib/utils";
import type { BinaryName } from "../../shared/rpcSchema";
import type { BinaryProgressInfo } from "@/api/BinaryService";

const BINARY_INFO: Record<BinaryName, { name: string; purpose: string }> = {
	ytDlp: { name: "yt-dlp", purpose: "media downloader" },
	ffmpeg: { name: "FFmpeg", purpose: "audio conversion" },
	deno: { name: "Deno", purpose: "JS runtime for yt-dlp" },
};

function InstallRow({
	binary,
	progress,
}: {
	binary: BinaryName;
	progress: BinaryProgressInfo;
}) {
	const info = BINARY_INFO[binary];
	const multiPart = progress.partCount > 1;
	let status: string;
	if (progress.done) {
		status = "Installed";
	} else if (progress.step === "extracting") {
		status = "Extracting…";
	} else if (progress.totalBytes) {
		status = `${formatMb(progress.receivedBytes)} / ${formatMb(progress.totalBytes)}`;
	} else if (progress.receivedBytes > 0) {
		status = formatMb(progress.receivedBytes);
	} else {
		status = "Waiting…";
	}
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center justify-between text-sm">
				<span className="font-medium">
					{info.name}
					{multiPart && !progress.done && (
						<span className="text-muted-foreground">
							{" "}
							({progress.part}/{progress.partCount})
						</span>
					)}
				</span>
				<span className="flex items-center gap-1 text-xs text-muted-foreground">
					{progress.done && <Check className="h-3.5 w-3.5 text-primary" />}
					{status}
				</span>
			</div>
			<Progress
				value={
					progress.done
						? 100
						: progress.step === "extracting" || !progress.totalBytes
							? null
							: (progress.receivedBytes / progress.totalBytes) * 100
				}
			/>
		</div>
	);
}

/**
 * Hard gate shown before login while required external binaries are missing.
 * The download only starts on user request; progress streams in from the bun
 * process via BinaryService.
 */
export function BinarySetupScreen() {
	const { binaries, service } = useBinaries();
	const { phase } = binaries;

	return (
		<div className="flex h-screen items-center justify-center bg-background p-4 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="items-center text-center">
					<Logo className="mb-2 h-14 w-14" />
					<CardTitle>Required components</CardTitle>
					<CardDescription>
						VexWave needs a few helper programs to import tracks from the web.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-4">
					{phase === "checking" && (
						<div className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" />
							Checking components…
						</div>
					)}

					{phase === "missing" && (
						<ul className="flex flex-col gap-2">
							{binaries.missing.map((binary) => (
								<li
									key={binary}
									className="flex items-baseline justify-between rounded-md border px-3 py-2 text-sm"
								>
									<span className="font-medium">
										{BINARY_INFO[binary].name}
									</span>
									<span className="text-xs text-muted-foreground">
										{BINARY_INFO[binary].purpose}
									</span>
								</li>
							))}
						</ul>
					)}

					{phase === "installing" && (
						<div className="flex flex-col gap-4">
							{(Object.keys(binaries.progress) as BinaryName[]).map(
								(binary) => {
									const progress = binaries.progress[binary];
									return progress ? (
										<InstallRow
											key={binary}
											binary={binary}
											progress={progress}
										/>
									) : null;
								},
							)}
						</div>
					)}

					{phase === "error" && binaries.error && (
						<div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
							<AlertCircle className="h-4 w-4 shrink-0" />
							<span>{binaries.error}</span>
						</div>
					)}

					{phase === "missing" && (
						<Button className="w-full" onClick={() => void service.install()}>
							<Download className="h-4 w-4" />
							Download
						</Button>
					)}
					{phase === "installing" && (
						<Button className="w-full" disabled>
							<Loader2 className="h-4 w-4 animate-spin" />
							Downloading…
						</Button>
					)}
					{phase === "error" && (
						<Button className="w-full" onClick={() => void service.retry()}>
							Retry
						</Button>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
