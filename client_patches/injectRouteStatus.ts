// Runtime state of the inject route installed by the generated installInjectRoute method.
export interface InjectRouteStatus {
	installed: boolean;
	lastError: string | undefined;
}

// A Page or BrowserContext instance produced by a patched Playwright build. Only the two
// state fields written by installInjectRoute are read, so the query stays independent of
// the concrete Playwright class hierarchy.
export type InjectRouteTarget = {
	routeInjecting: boolean;
	injectRouteError?: string | undefined;
};

/**
 * Returns whether the inject route is installed on the given Page or BrowserContext and the
 * message of the most recent failed installation attempt, if any.
 *
 * Before the first installation attempt both values are unset, so the result is
 * `{ installed: false, lastError: undefined }`. A failed attempt leaves `installed` false
 * and records the error; a later successful attempt clears the error again.
 */
export function getInjectRouteStatus(target: InjectRouteTarget): InjectRouteStatus {
	return {
		installed: target.routeInjecting === true,
		lastError: target.injectRouteError,
	};
}
