import { Spinner } from "@shuyi-harness/ui/components/ui/spinner";

export default function Loader() {
	return (
		<div className="flex h-full items-center justify-center pt-8">
			<Spinner className="text-muted-foreground" />
		</div>
	);
}
