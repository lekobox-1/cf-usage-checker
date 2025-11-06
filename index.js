export default {
  async fetch(request, env, ctx) {
    const Email = env.CF_EMAIL;           // 可选：旧式认证邮箱
    const GlobalAPIKey = env.CF_API_KEY;  // 可选：旧式全局 API Key
    const APIToken = env.CF_API_TOKEN;    // 推荐：API Token
    const AccountID = env.CF_ACCOUNT_ID;  // 可选：账户 ID

    const result = await getCloudflareUsage(Email, GlobalAPIKey, AccountID, APIToken);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
};

async function getCloudflareUsage(Email, GlobalAPIKey, AccountID, APIToken) {
  const API = "https://api.cloudflare.com/client/v4";
  const sum = (a) => a?.reduce((t, i) => t + (i?.sum?.requests || 0), 0) || 0;
  const cfg = { "Content-Type": "application/json" };

  try {
    // ---- 1️⃣ 检查参数 ----
    if (!AccountID && (!Email || !GlobalAPIKey))
      throw new Error("请提供 AccountID 或 Email+GlobalAPIKey");

    // ---- 2️⃣ 自动获取 Account ID ----
    if (!AccountID) {
      const r = await fetch(`${API}/accounts`, {
        method: "GET",
        headers: { ...cfg, "X-AUTH-EMAIL": Email, "X-AUTH-KEY": GlobalAPIKey }
      });
      if (!r.ok) throw new Error(`账户获取失败: ${r.status}`);
      const d = await r.json();
      if (!d?.result?.length) throw new Error("未找到账户");
      AccountID = d.result[0].id;
    }

    // ---- 3️⃣ 准备时间过滤条件 ----
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const hdr = APIToken
      ? { ...cfg, Authorization: `Bearer ${APIToken}` }
      : { ...cfg, "X-AUTH-EMAIL": Email, "X-AUTH-KEY": GlobalAPIKey };

    // ---- 4️⃣ 发起 GraphQL 查询 ----
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: hdr,
      body: JSON.stringify({
        query: `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
          viewer {
            accounts(filter: { accountTag: $AccountID }) {
              pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
              workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
            }
          }
        }`,
        variables: {
          AccountID,
          filter: {
            datetime_geq: now.toISOString(),
            datetime_leq: new Date().toISOString()
          }
        }
      })
    });

    if (!res.ok) throw new Error(`查询失败: ${res.status}`);
    const result = await res.json();
    if (result.errors?.length) throw new Error(result.errors[0].message);

    // ---- 5️⃣ 汇总统计 ----
    const acc = result?.data?.viewer?.accounts?.[0];
    if (!acc) throw new Error("未找到账户数据");

    const pages = sum(acc.pagesFunctionsInvocationsAdaptiveGroups);
    const workers = sum(acc.workersInvocationsAdaptive);
    const total = pages + workers;

    return { success: true, pages, workers, total, account: AccountID };
  } catch (err) {
    return { success: false, error: err.message, pages: 0, workers: 0, total: 0 };
  }
}