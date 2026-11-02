"use client";

import { useState } from "react";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { PathInput } from "@/components/path-input";
import { cn } from "@/lib/utils";

/** An in-flow practice problem and its thinking field. */

export interface PracticeDockProps {
	/** The active problem's tool-call id (submissions target it). */
	problemCallId: string;
	/** The pose's arguments — only the statement is the learner's (the
	 *  mode badge would edge toward announcing the target; dropped). */
	input: { statement: string };
	/** text — POST {type:"thinking"} (one lane; the register is read from the text).
	 *  onAccepted fires at the server's ack; the result is send()'s (false =
	 *  refused or failed, the text stays). */
	onSubmit: (text: string, onAccepted: () => void) => boolean | Promise<boolean>;
	/** Compaction is running for this chat (owner round 14): the thinking
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
	/** A turn is running (audit fix, 2026-11-03): send() refuses while the
	 *  session isn't ready, so submit is disabled rather than silently
	 *  dropping the learner's thinking. */
	busy?: boolean;
}

export function PracticeDock({ problemCallId, input, onSubmit, compactionRunning = false, busy = false }: PracticeDockProps) {
	const [thinking, setThinking] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const blocked = compactionRunning || busy || submitting;

	// Keep-until-accepted (audit fix, 2026-11-03): the field used to clear
	// before the send, so a refused send (a turn still running) lost the
	// text. Clear at the server's ack (send() itself resolves only after the
	// turn's stream), or on a true result — and only if the learner hasn't
	// typed on since. A false result leaves the text in place.
	const submit = () => {
		if (blocked) return;
		const text = thinking.trim();
		if (text.length === 0) return;
		const clear = () => setThinking((cur) => (cur.trim() === text ? "" : cur));
		setSubmitting(true);
		void Promise.resolve(onSubmit(text, clear))
			.then((accepted) => {
				if (accepted) clear();
			})
			.catch(() => {})
			.finally(() => setSubmitting(false));
	};


	return (
		<div data-testid="practice-dock" data-problem={problemCallId}>
			<div className="px-4 pt-3 pb-2">
				<div className="mb-1 text-xs font-medium text-primary">Problem</div>
				<div className="font-prose text-lg">
					<ToolContentResponse>{input.statement}</ToolContentResponse>
				</div>
			</div>

			{/* The learner's half: Enter SENDS (owner round 2, 2026-10-05);
			    Shift+Enter makes a newline — less to decide about. */}
			<div
				data-testid="practice-thinking-field"
				className="m-1.5 rounded-md border border-border bg-card transition-colors focus-within:border-primary"
			>
				<div className="px-2.5 pt-2 text-xs font-medium text-muted-foreground">
					Your thinking
				</div>
				<PathInput
					value={thinking}
					onValueChange={setThinking}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							submit();
						}
					}}
					placeholder="Work here, think out loud."
					className={cn(
						"field-sizing-content lh-input max-h-64 min-h-16 w-full resize-none bg-transparent px-2.5 pb-2 font-ui outline-none placeholder:text-muted-foreground",
					)}
				/>
				{/* Redesign (owner, 2026-10-27): keep the keyboard hint and
				    submit behavior, but give the action a full touch target. */}
				<div className="flex items-center justify-between gap-2 p-1">
					<span aria-hidden className="pl-1.5 text-xs text-muted-foreground">
						{compactionRunning ? "Compacting session…" : "Enter submits, Shift+Enter starts a new line"}
					</span>
					<Button
						type="button"
						data-testid="practice-send"
						disabled={thinking.trim().length === 0 || blocked}
						onClick={() => submit()}
						className="ml-auto min-h-11 rounded-md px-3.5 text-sm font-semibold"
					>
						Submit thinking
					</Button>
				</div>
			</div>
		</div>
	);
}
