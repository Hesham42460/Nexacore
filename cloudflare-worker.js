// كود Cloudflare Worker الجاهز لنظام NexaCore ERP (انسخه والصقه في Cloudflare Workers)
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization") || "";
    const secret = env.ERP_SECRET || "5243535Ss#";
    if (auth !== "Bearer " + secret && url.pathname !== "/license-check") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: cors });
    }
    if (env.DB) {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS erp_store (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)").run();
    }
    const getVal = async (key) => {
      if (env.DB) {
        const row = await env.DB.prepare("SELECT v FROM erp_store WHERE k = ?").bind(key).first();
        return row ? row.v : null;
      }
      if (env.ERP_KV) return await env.ERP_KV.get(key);
      return null;
    };
    const setVal = async (key, val) => {
      const now = new Date().toISOString();
      if (env.DB) {
        await env.DB.prepare("INSERT OR REPLACE INTO erp_store (k, v, updated_at) VALUES (?, ?, ?)").bind(key, val, now).run();
      } else if (env.ERP_KV) {
        await env.ERP_KV.put(key, val);
      }
    };
    if (url.pathname === "/license-check") {
      const lic = await getVal("LICENSES_MASTER");
      return new Response(lic || JSON.stringify({ tenants: {} }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (url.pathname === "/licenses" && request.method === "POST") {
      const body = await request.text();
      await setVal("LICENSES_MASTER", body);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    const tenant = url.searchParams.get("tenant") || "COMP-001";
    const key = "TENANT_" + tenant;
    if (request.method === "GET") {
      const data = await getVal(key);
      return new Response(data || "null", { headers: { ...cors, "Content-Type": "application/json" } });
    }
    if (request.method === "POST" || request.method === "PUT") {
      const body = await request.text();
      await setVal(key, body);
      return new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response("NexaCore ERP Cloudflare Server Ready", { headers: cors });
  }
};
