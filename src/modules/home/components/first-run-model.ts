/** Pure model for the Home first-run checklist (no React; unit-tested). */
/** One first-run step (pure; unit-tested through firstRunSteps). */
export interface FirstRunStep { id: "matter" | "documents" | "provider" | "team"; title: string; detail: string; href: string; done: boolean }

export function firstRunSteps(input: { matters: number; documents: number; people: number; aiConfigured: boolean }): FirstRunStep[] {
  return [
    { id: "matter", title: "Create a matter", detail: "Caption, client, court and key dates. Everything else is organised by matter.", href: "/matters?new=1", done: input.matters > 0 },
    { id: "documents", title: "Upload documents", detail: "Pleadings, orders and correspondence: ask questions, pull facts and build timelines.", href: "/documents", done: input.documents > 0 },
    { id: "provider", title: "Connect a model provider", detail: "Amazon Bedrock, Anthropic or OpenAI, configured in the environment.", href: "/settings#ai", done: input.aiConfigured },
    { id: "team", title: "Invite your team", detail: "Add colleagues so matters, tasks and updates can be shared.", href: "/settings#team", done: input.people > 1 },
  ];
}
