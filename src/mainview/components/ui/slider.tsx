import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";

import { cn } from "@/lib/utils";

interface SliderProps
	extends React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> {
	/** How the value should be read out, when the number alone doesn't say it. */
	valueText?: string;
}

const Slider = React.forwardRef<
	React.ElementRef<typeof SliderPrimitive.Root>,
	SliderProps
>(
	(
		{
			className,
			// What names and describes the control is pulled off the root and put on
			// the thumb (not upstream shadcn): the thumb is what carries
			// `role="slider"`, and Radix only names it itself when there is more
			// than one. Left on the root these reach a plain span, and the control
			// has no accessible name at all.
			"aria-label": ariaLabel,
			"aria-labelledby": ariaLabelledBy,
			"aria-describedby": ariaDescribedBy,
			valueText,
			...props
		},
		ref,
	) => (
		<SliderPrimitive.Root
			ref={ref}
			className={cn(
				"relative flex w-full touch-none select-none items-center",
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Track className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
				<SliderPrimitive.Range className="absolute h-full bg-primary" />
			</SliderPrimitive.Track>
			<SliderPrimitive.Thumb
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				aria-describedby={ariaDescribedBy}
				aria-valuetext={valueText}
				className="block h-4 w-4 rounded-full border border-primary/50 bg-background shadow transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
			/>
		</SliderPrimitive.Root>
	),
);
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
