export default {
  async fetch(request, env, ctx) {
    // 多个 Cloudflare API Token，以逗号分隔
    const tokens = (env.MULTI_CF_API_TOKENS || "")
      .split(",")
      .map(t => t.trim())
      .filter(Boolean);

    if (!tokens.length) {
      return new Response(
        JSON.stringify({ success: false, error: "未提供任何 CF API Token", accounts: [] }, null, 2),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    // 获取 Cloudflare 各账户使用量
    const result = await getCloudflareUsage(tokens);

    // 发送 Telegram 通知
    if (result.success && result.accounts.length) {
      const message = formatAccountReport(result.accounts);
      await sendTelegramNotification(env, message);
    }

    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
};

/**
 * Telegram 通知函数
 */
async function sendTelegramNotification(env, message) {
  const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ 未设置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID");
    return { success: false, error: "缺少 Telegram 配置" };
  }

  const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(telegramUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML"
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ Telegram 发送失败:", text);
    return { success: false, status: res.status, message: text };
  }

  return { success: true, message: "Telegram notification sent!" };
}

/**
 * 格式化账户信息为 Telegram 消息
 */
function formatAccountReport(accounts) {
  return accounts.map(acc => 
    `📦 <b>${acc.account_name}</b>\n` +
    `📄 Pages: <code>${acc.pages}</code>\n` +
    `⚙️ Workers: <code>${acc.workers}</code>\n` +
    `📊 Total: <code>${acc.total}</code>\n` +
    `💰 Free quota remaining: <code>${acc.free_quota_remaining}</code>\n`
  ).join("\n——————————————\n");
}

/**
 * 并发执行多个异步任务（限制并发数量）
 */
async function promisePool(tasks, concurrency = 5) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const p = task().then(res => results.push(res));
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // 移除已完成 Promise
      for (let i = executing.length - 1; i >= 0; i--) {
        if (executing[i].done) executing.splice(i, 1);
      }
    }
  }

  await Promise.all(executing);
  return results.flat();
}

/**
 * 获取多个 Cloudflare Token 的使用情况
 */
async function getCloudflareUsage(tokens) {
  const API = "https://api.cloudflare.com/client/v4";
  const FREE_LIMIT = 100000;
  const sum = (a) => a?.reduce((t, i) => t + (i?.sum?.requests || 0), 0) || 0;

  try {
    const allTasks = tokens.map(APIToken => async () => {
      const cfg = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${APIToken}`
      };

      // 获取账户列表
      const accRes = await fetch(`${API}/accounts`, { headers: cfg });
      if (!accRes.ok) throw new Error(`账户获取失败: ${accRes.status}`);
      const accData = await accRes.json();
      if (!accData?.result?.length) return [];

      const now = new Date();
      now.setUTCHours(0, 0, 0, 0);

      // 每个账户的任务
      const accountTasks = accData.result.map(account => async () => {
        const AccountName = account.name || "未知账户";

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
              AccountID: account.id,
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

        const accUsage = result?.data?.viewer?.accounts?.[0];
        const pages = sum(accUsage?.pagesFunctionsInvocationsAdaptiveGroups);
        const workers = sum(accUsage?.workersInvocationsAdaptive);
        const total = pages + workers;
        const free_quota_remaining = Math.max(0, FREE_LIMIT - total);

        return {
          account_name: AccountName,
          pages,
          workers,
          total,
          free_quota_remaining
        };
      });

      // 限制每个 Token 下并发数量
      return promisePool(accountTasks, 5);
    });

    // 限制 Token 并发数量
    const accountsResults = await promisePool(allTasks, 3);

    return { success: true, accounts: accountsResults.flat() };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      accounts: []
    };
  }
}