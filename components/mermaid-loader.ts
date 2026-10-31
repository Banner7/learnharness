// Deferred charts (2026-10-31): static import would put Mermaid in the
// initial JS for every route. Both chart surfaces share one renderer/config.
export const MERMAID_FONT_SIZE = 16;

export async function renderMermaidOnDemand(chart: string): Promise<string> {
	const { renderMermaid } = await import("@/components/mermaid-render");
	return renderMermaid(chart);
}
