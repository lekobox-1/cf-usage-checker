
export default {
  async fetch(request, env, ctx) {
    // 多个 Token 以逗号分隔
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

    const data = await getCloudflareUsage(tokens);

        const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cloudflare 账户数据仪表盘</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body {
      background: linear-gradient(135deg, #f0f4ff, #e3f6f5);
      font-family: 'Inter', sans-serif;
    }
    .card {
      background: white;
      border-radius: 1.25rem;
      padding: 1.75rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.05);
      border: 1px solid rgba(255,255,255,0.7);
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: "";
      position: absolute;
      top: -50%;
      left: -50%;
      width: 200%;
      height: 200%;
      background: radial-gradient(circle at center, rgba(99,102,241,0.05), transparent 70%);
      transform: rotate(25deg);
    }
    .card:hover {
      transform: translateY(-5px) scale(1.02);
      box-shadow: 0 15px 40px rgba(99,102,241,0.15);
    }
    .progress {
      transition: width 1s ease;
    }
    .num {
      transition: all 0.4s ease-out;
    }
  </style>
</head>
<body class="flex flex-col items-center p-8">
  <header class="mb-10 text-center">
    <h1 class="text-4xl font-extrabold text-indigo-600 drop-shadow-sm">🌤️ Cloudflare 数据仪表盘</h1>
    <p class="text-gray-600 mt-2">账户使用情况可视化展示</p>
  </header>

  <main class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8 w-full max-w-6xl">
    ${data.accounts.map(acc => {
      const usedPercent = (acc.total / (acc.total + acc.free_quota_remaining) * 100).toFixed(1);
      return `
      <div class="card backdrop-blur-sm relative">
        <h2 class="text-2xl font-semibold text-gray-800 mb-4">${acc.account_name}</h2>
        <div class="space-y-2 text-gray-700">
          <p><strong>📄 Pages:</strong> <span class="num" data-value="${acc.pages}">0</span></p>
          <p><strong>⚙️ Workers:</strong> <span class="num" data-value="${acc.workers}">0</span></p>
          <p><strong>📦 总计:</strong> <span class="num" data-value="${acc.total}">0</span></p>
          <p><strong>🎁 免费额度剩余:</strong> <span class="num" data-value="${acc.free_quota_remaining}">0</span></p>
        </div>
        <div class="mt-5">
          <div class="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
            <div class="bg-gradient-to-r from-green-400 to-blue-500 h-3 rounded-full progress" style="width: ${usedPercent}%"></div>
          </div>
          <p class="text-sm text-gray-500 mt-2 text-right">${usedPercent}% 已使用</p>
        </div>
      </div>
      `;
    }).join('')}
  </main>

  <footer class="mt-12 text-gray-500 text-sm">
    © ${new Date().getFullYear()} Cloudflare Worker Dashboard • Designed with 💜 by ChatGPT
  </footer>

  <script>
    // 数字滚动动画
    document.querySelectorAll('.num').forEach(el => {
      const target = +el.getAttribute('data-value');
      let count = 0;
      const step = target / 50;
      const timer = setInterval(() => {
        count += step;
        if (count >= target) {
          count = target;
          clearInterval(timer);
        }
        el.textContent = Math.floor(count).toLocaleString();
      }, 20);
    });
  </script>
</body>
</html>
`;
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
    
};

/**
 * 并发执行多个异步任务，限制同时运行数量
 * @param {Array<Function>} tasks - 返回 Promise 的函数数组
 * @param {number} concurrency - 最大同时执行数量
 */
async function promisePool(tasks, concurrency = 5) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const p = task().then(res => results.push(res));
    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // 移除已完成的 Promise
      for (let i = executing.length - 1; i >= 0; i--) {
        if (executing[i].done) executing.splice(i, 1);
      }
    }
  }

  await Promise.all(executing);
  return results.flat();
}

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

      // 获取该 Token 下所有账户
      const accRes = await fetch(`${API}/accounts`, { headers: cfg });
      if (!accRes.ok) throw new Error(`账户获取失败: ${accRes.status}`);
      const accData = await accRes.json();
      if (!accData?.result?.length) return [];

      const now = new Date();
      now.setUTCHours(0, 0, 0, 0);

      // 为每个账户创建一个异步任务
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

      // 并发执行账户查询任务（限制每个 Token 下最大 5 个并发）
      return promisePool(accountTasks, 5);
    });

    // 并发执行 Token 查询任务（限制同时执行 3 个 Token）
    const accountsResults = await promisePool(allTasks, 3);

    return { success: true, accounts: accountsResults };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      accounts: []
    };
  }
}