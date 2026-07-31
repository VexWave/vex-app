import {
	useEffect,
	useReducer,
	useState,
	type FormEvent,
	type ReactNode,
} from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Logo } from "@/components/Logo";
import { useSession } from "@/hooks/useSession";
import { formatTime } from "@/lib/utils";
import {
	MAX_PASSWORD_LENGTH,
	MAX_USERNAME_LENGTH,
} from "../../shared/limits";

function Field({
	id,
	label,
	children,
}: {
	id: string;
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-sm font-medium leading-none">
				{label}
			</label>
			{children}
		</div>
	);
}

export function LoginScreen() {
	const { session, service } = useSession();
	const [host, setHost] = useState(session.lastHost);
	const [port, setPort] = useState(session.lastPort);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [validationError, setValidationError] = useState<string | null>(null);
	// The timer below only forces the re-render; the time left is read from the
	// clock during it, so the first render after a 429 already shows the real
	// countdown rather than one based on whenever the last tick happened.
	const [, tick] = useReducer((count: number) => count + 1, 0);

	const loggingIn = session.status === "loggingIn";
	const error = validationError ?? session.error;
	// Server-imposed wait after a 429; the contract requires honouring it rather
	// than letting the user retry straight into the throttle.
	const remainingMs = Math.max(0, (session.retryAfter ?? 0) - Date.now());

	// A clock only while one is actually running — an expired deadline needs no
	// timer, and neither does the form in the common case.
	useEffect(() => {
		const endsAt = session.retryAfter;
		if (endsAt === null) return;
		const id = setInterval(() => {
			tick();
			if (Date.now() >= endsAt) clearInterval(id);
		}, 1000);
		return () => clearInterval(id);
	}, [session.retryAfter]);

	const handleSubmit = (e: FormEvent) => {
		e.preventDefault();
		const portNumber = Number(port);
		if (!host.trim() || !username || !password) {
			setValidationError("Host, username and password are required.");
			return;
		}
		if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
			setValidationError("Port must be a number between 1 and 65535.");
			return;
		}
		setValidationError(null);
		void service.login(host.trim(), portNumber, username, password);
	};

	return (
		<div className="flex h-screen items-center justify-center bg-background p-4 text-foreground">
			<Card className="w-full max-w-sm">
				<CardHeader className="items-center text-center">
					<Logo className="mb-2 h-14 w-14" />
					<CardTitle>Welcome to VexWave</CardTitle>
					<CardDescription>
						Enter the address of a running server and log in with your
						credentials.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="flex flex-col gap-4" onSubmit={handleSubmit}>
						<div className="grid grid-cols-[1fr_100px] gap-3">
							<Field id="host" label="Host">
								<Input
									id="host"
									placeholder="localhost"
									autoFocus
									value={host}
									onChange={(e) => setHost(e.target.value)}
									disabled={loggingIn}
								/>
							</Field>
							<Field id="port" label="Port">
								<Input
									id="port"
									inputMode="numeric"
									placeholder="8080"
									value={port}
									onChange={(e) => setPort(e.target.value)}
									disabled={loggingIn}
								/>
							</Field>
						</div>
						<Field id="username" label="Username">
							<Input
								id="username"
								autoComplete="username"
								maxLength={MAX_USERNAME_LENGTH}
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								disabled={loggingIn}
							/>
						</Field>
						<Field id="password" label="Password">
							<Input
								id="password"
								type="password"
								autoComplete="current-password"
								maxLength={MAX_PASSWORD_LENGTH}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								disabled={loggingIn}
							/>
						</Field>
						{error && (
							<div className="flex items-center gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
								<AlertCircle className="h-4 w-4 shrink-0" />
								<span>{error}</span>
							</div>
						)}
						<Button
							type="submit"
							className="w-full"
							disabled={loggingIn || remainingMs > 0}
						>
							{loggingIn && <Loader2 className="h-4 w-4 animate-spin" />}
							{remainingMs > 0
								? `Try again in ${formatTime(Math.ceil(remainingMs / 1000))}`
								: loggingIn
									? "Connecting…"
									: "Log in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
