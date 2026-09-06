import { convertQueryParamsToUrlString } from "@ts-rest/core";

const VERSION_PARAM = "v";

export function imageVersion(url: string): string | undefined {
	const query = url.indexOf("?");
	if (query === -1) return undefined;
	return new URLSearchParams(url.slice(query + 1)).get(VERSION_PARAM) || undefined;
}

export function versionQuery(version: string | undefined): string {
	return convertQueryParamsToUrlString({ [VERSION_PARAM]: version });
}
