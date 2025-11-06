export default {
  async fetch(request, env, ctx) {
    const result = await getCloudflareUsage(env.CF_API_TOKEN, env.CF_ACCOUNT_ID);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
};

async function getCloudflareUsage(APIToken, AccountIDFromEnv) {
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

    // 2️⃣ 获取账户信息
    let AccountID = AccountIDFromEnv;
    let AccountName = "未知账户";

    if (!AccountID) {
      const accRes = await fetch(`${API}/accounts`, { headers: cfg });
      if (!accRes.ok) throw new Error(`账户获取失败: ${accRes.status}`);
      const accData = await accRes.json();
      if (!accData?.result?.length) throw new Error("未找到账户");
      const account = accData.result[0];
      AccountID = account.id;
      AccountName = account.name || "未命名账户";
    } else {
      // 若提供了 AccountID，则尝试读取该账户信息
      const accRes = await fetch(`${API}/accounts/${AccountID}`, { headers: cfg });
      if (accRes.ok) {
        const accData = await accRes.json();
        AccountName = accData?.result?.name || "未命名账户";
      }
    }

    // 3️⃣ 时间范围（当天 UTC 0点 ~ 当前时间）
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);

    // 4️⃣ 发起 GraphQL 查询
    const res = await fetch(`${API}/graphql`, {
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

    // 5️⃣ 汇总结果
    const acc = result?.data?.viewer?.accounts?.[0];
    if (!acc) throw new Error("未找到账户数据");

    const pages = sum(acc.pagesFunctionsInvocationsAdaptiveGroups);
    const workers = sum(acc.workersInvocationsAdaptive);
    const total = pages + workers;

    // ✅ 返回完整信息
    return {
      success: true,
      accountId: AccountID,
      accountName: AccountName,
      accountEmail: AccountEmail,
      pages,
      workers,
      total
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      accountId: null,
      accountName: null,
      accountEmail: null,
      pages: 0,
      workers: 0,
      total: 0
    };
  }
}