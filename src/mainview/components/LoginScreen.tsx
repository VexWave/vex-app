import { useState, type FormEvent, type ReactNode } from "react";
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
import { useSession } from "@/hooks/useSession";

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

	const loggingIn = session.status === "loggingIn";
	const error = validationError ?? session.error;

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
				<CardHeader>
					<CardTitle>Connect to server</CardTitle>
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
						<Button type="submit" className="w-full" disabled={loggingIn}>
							{loggingIn && <Loader2 className="h-4 w-4 animate-spin" />}
							{loggingIn ? "Connecting…" : "Log in"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
