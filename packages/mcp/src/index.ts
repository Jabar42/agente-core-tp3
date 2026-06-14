import { Agent, routeAgentRequest } from "agents";

type Env = { VarsanaMCP: DurableObjectNamespace; API_BASE_URL: string };

export class VarsanaMCP extends Agent<Env> {
  async fetch(request: Request): Promise<Response> {
    return Response.json({ ok: true, agent: "VarsanaMCP", time: Date.now() });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 });
  },
};
