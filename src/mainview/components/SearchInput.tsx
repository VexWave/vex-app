import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The app's list filter: a search field with a leading icon and a clear button
 * that appears once something is typed. Every list that filters (library,
 * artists, the playlist track picker) uses this one so they look and behave
 * alike; the width comes from `className`.
 */
export function SearchInput({
	value,
	onChange,
	placeholder = "Search",
	label,
	className,
	autoFocus,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Accessible name — the field has no visible label. */
	label: string;
	className?: string;
	autoFocus?: boolean;
}) {
	return (
		<div className={cn("relative", className)}>
			<Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
			<Input
				autoFocus={autoFocus}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				aria-label={label}
				className="h-8 pl-8 pr-7 text-xs"
			/>
			{value && (
				<button
					type="button"
					aria-label="Clear search"
					className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => onChange("")}
				>
					<X className="h-3.5 w-3.5" />
				</button>
			)}
		</div>
	);
}
