export default {
  async fetch(request, env, ctx) {
    const result = await getCloudflareUsage(env.CF_API_TOKEN);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
};

async function getCloudflareUsage(APIToken) {
  const API = "https://api.cloudflare.com/client/v4";
  const cfg = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${APIToken}`
  };
  const sum = (a) => a?.reduce((t, i) => t + (i?.sum?.requests || 0), 0) || 0;

  try {
    // 1️⃣ 获取用户邮箱
    const userRes = await fetch(`${API}/user`, { headers: cfg });
    if (!userRes.ok) throw new Error(`用户信息获取失败: ${userRes.status}`);
    const userData = await userRes.json();
    const AccountEmail = userData?.result?.email || "未知邮箱";

    // 2️⃣ 获取所有账户
    const accRes = await fetch(`${API}/accounts`, { headers: cfg });
    if (!accRes.ok) throw new Error(`账户列表获取失败: ${accRes.status}`);
    const accData = await accRes.json();
    const accounts = accData?.result || [];
    if (!accounts.length) throw new Error("未找到账户");

    // 3️⃣ 定义时间范围（当天 UTC 0点 ~ 当前时间）
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const datetime_geq = now.toISOString();
    const datetime_leq = new Date().toISOString();

    // 4️⃣ 并发获取每个账户的用量
    const results = await Promise.all(
      accounts.map(async (acc) => {
        const AccountID = acc.id;
        const AccountName = acc.name || "未命名账户";

        const gql = await fetch(`${API}/graphql`, {
          method: "POST",
          headers: cfg,
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
              filter: { datetime_geq, datetime_leq }
            }
          })
        });

        if (!gql.ok) {
          return {
            id: AccountID,
            name: AccountName,
            pages: 0,
            workers: 0,
            total: 0,
            error: `查询失败: ${gql.status}`
          };
        }

        const gqlResult = await gql.json();
        const data = gqlResult?.data?.viewer?.accounts?.[0];
        if (!data) {
          return {
            id: AccountID,
            name: AccountName,
            pages: 0,
            workers: 0,
            total: 0,
            error: "无数据"
          };
        }

        const pages = sum(data.pagesFunctionsInvocationsAdaptiveGroups);
        const workers = sum(data.workersInvocationsAdaptive);
        const total = pages + workers;

        return { id: AccountID, name: AccountName, pages, workers, total };
      })
    );

    // ✅ 汇总结果
    return {
      success: true,
      email: AccountEmail,
      accounts: results
    };

  } catch (err) {
    return {
      success: false,
      error: err.message,
      email: null,
      accounts: []
    };
  }
}