import { useEffect, useState } from "react";
import { Link, Redirect, Route, Switch } from "wouter";
import { Chat } from "@/components/chat";
import { Home } from "@/components/home";
import { NewSession } from "@/components/new-session";
import type { LhMessage } from "@/src/core";
import { useRefreshRevision, useSearchParams } from "./navigation";

interface ChatSnapshot {
	id: string;
	title: string;
	kind?: "teach" | "practice";
	messages: LhMessage[];
	turnInFlight: boolean;
	compacting: boolean;
	turnFailure: string | null;
}

type ChatLoad =
	| { status: "loading" }
	| { status: "missing" }
	| { status: "error"; message: string }
	| { status: "ready"; chat: ChatSnapshot };

function NotFound() {
	return (
		<main className="mx-auto flex min-h-dvh max-w-[640px] flex-col justify-center gap-4 px-4">
			<h1 className="font-title text-2xl">Page not found</h1>
			<p className="text-muted-foreground">This page or session no longer exists.</p>
			<Link href="/" className="text-primary underline">Return home</Link>
		</main>
	);
}

function ChatPage({ id }: { id: string }) {
	const searchParams = useSearchParams();
	const revision = useRefreshRevision();
	const [load, setLoad] = useState<ChatLoad>({ status: "loading" });

	useEffect(() => {
		const controller = new AbortController();
		setLoad({ status: "loading" });
		void (async () => {
			try {
				const response = await fetch(`/api/chats/${encodeURIComponent(id)}`, { signal: controller.signal });
				if (response.status === 404) {
					if (!controller.signal.aborted) setLoad({ status: "missing" });
					return;
				}
				if (!response.ok) throw new Error(`Could not load this session (${response.status}).`);
				const chat = await response.json() as ChatSnapshot;
				if (!controller.signal.aborted) setLoad({ status: "ready", chat });
			} catch (error) {
				if (!controller.signal.aborted) {
					setLoad({ status: "error", message: error instanceof Error ? error.message : "Could not load this session." });
				}
			}
		})();
		return () => controller.abort();
	}, [id, revision]);

	if (load.status === "loading") {
		return <p role="status" className="p-4 text-muted-foreground">Loading session…</p>;
	}
	if (load.status === "missing") return <NotFound />;
	if (load.status === "error") {
		return <p role="alert" className="p-4 text-destructive">{load.message}</p>;
	}
	const { chat } = load;
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			initialMessages={chat.messages}
			initialError={chat.turnFailure ?? undefined}
			initialPrompt={searchParams.get("prompt") ?? undefined}
			initiallyInFlight={chat.turnInFlight}
			initiallyCompacting={chat.compacting}
		/>
	);
}

function NewSessionPage() {
	const searchParams = useSearchParams();
	return <NewSession mode={searchParams.get("mode") === "practice" ? "practice" : "teach"} />;
}

export function Pages() {
	return (
		<Switch>
			<Route path="/"><Home /></Route>
			<Route path="/chat/new"><NewSessionPage /></Route>
			<Route path="/chat/:id">{({ id }) => <ChatPage key={id} id={id} />}</Route>
			<Route path="/settings"><Redirect to="/chat/new" replace /></Route>
			<Route><NotFound /></Route>
		</Switch>
	);
}
