import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";

const RefreshContext = createContext({ revision: 0, refresh: () => {} });

/** Fork rewrite (2026-10-29): SPA refresh rereads the chat snapshot rather
 * than reloading the document and dropping the shared event connection. */
export function NavigationProvider({ children }: { children: ReactNode }) {
	const [revision, setRevision] = useState(0);
	const refresh = useCallback(() => setRevision((value) => value + 1), []);
	const value = useMemo(() => ({ revision, refresh }), [revision, refresh]);
	return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

export function useRefreshRevision() {
	return useContext(RefreshContext).revision;
}

export function useRouter() {
	const [, navigate] = useLocation();
	const { refresh } = useContext(RefreshContext);
	return useMemo(() => ({
		push: (href: string) => navigate(href),
		replace: (href: string) => navigate(href, { replace: true }),
		back: () => window.history.back(),
		refresh,
	}), [navigate, refresh]);
}

export function usePathname() {
	return useLocation()[0];
}

export function useSearchParams() {
	const search = useSearch();
	return useMemo(() => new URLSearchParams(search), [search]);
}
