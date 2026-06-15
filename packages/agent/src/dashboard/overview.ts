/**
 * Overview dashboard page — KPIs + 30-day chart.
 * Returns a complete HTML string with inline CSS and vanilla JS + Chart.js.
 */
export function overviewPage(): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard — Agente</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #f8f9fa;
    --card: #ffffff;
    --text: #1a1a2e;
    --muted: #6c757d;
    --border: #e2e8f0;
    --primary: #2563eb;
    --primary-fg: #fff;
    --success: #16a34a;
    --warning: #ea580c;
    --danger: #dc2626;
    --radius: 12px;
    --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
  }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  nav { background: var(--card); border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; gap: 24px; height: 56px; box-shadow: var(--shadow); }
  nav a { text-decoration: none; color: var(--muted); font-size: 14px; font-weight: 500; padding: 8px 0; border-bottom: 2px solid transparent; transition: all 0.15s; }
  nav a:hover, nav a.active { color: var(--primary); border-bottom-color: var(--primary); }
  nav .brand { font-weight: 700; color: var(--text); font-size: 16px; margin-right: auto; }
  main { max-width: 1200px; margin: 0 auto; padding: 32px 24px; }
  h1 { font-size: 24px; font-weight: 700; margin-bottom: 24px; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .kpi { background: var(--card); border-radius: var(--radius); padding: 20px; box-shadow: var(--shadow); border: 1px solid var(--border); }
  .kpi .label { font-size: 13px; color: var(--muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .kpi .value { font-size: 32px; font-weight: 700; }
  .kpi .sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .chart-card { background: var(--card); border-radius: var(--radius); padding: 24px; box-shadow: var(--shadow); border: 1px solid var(--border); }
  .chart-card h2 { font-size: 16px; font-weight: 600; margin-bottom: 16px; }
  .chart-wrap { position: relative; height: 320px; }
  .error-state { text-align: center; padding: 48px; color: var(--muted); }
  .loading { text-align: center; padding: 48px; color: var(--muted); }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 12px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<nav>
  <span class="brand">Dashboard Agente</span>
  <a href="/admin" class="active">Overview</a>
  <a href="/admin/conversations">Conversaciones</a>
  <a href="/admin/prompts">Prompts</a>
</nav>
<main>
  <h1>Métricas del Agente</h1>
  <div class="kpis" id="kpis">
    <div class="kpi"><div class="label">Mensajes Hoy</div><div class="value" id="kpi-msgs">—</div><div class="sub">Total de mensajes del día</div></div>
    <div class="kpi"><div class="label">Tool Calls Hoy</div><div class="value" id="kpi-tools">—</div><div class="sub">Ejecuciones de herramientas</div></div>
    <div class="kpi"><div class="label">Tasa de Error</div><div class="value" id="kpi-err">—</div><div class="sub">Errores / total tool calls</div></div>
    <div class="kpi"><div class="label">Conexiones</div><div class="value" id="kpi-conn">—</div><div class="sub">WebSockets activos</div></div>
  </div>
  <div class="chart-card">
    <h2>Mensajes por día (últimos 30 días)</h2>
    <div class="chart-wrap"><canvas id="chart"></canvas></div>
  </div>
</main>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<script>
(async () => {
  const kpiMsgs = document.getElementById("kpi-msgs");
  const kpiTools = document.getElementById("kpi-tools");
  const kpiErr = document.getElementById("kpi-err");
  const kpiConn = document.getElementById("kpi-conn");
  const chartCanvas = document.getElementById("chart");

  try {
    const resp = await fetch("/admin/api/stats");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    const today = data.today || {};
    const series = data.series || [];

    kpiMsgs.textContent = today.messages ?? 0;
    kpiTools.textContent = today.tool_calls ?? 0;
    const total = (today.tool_calls || 0) + (today.tool_errors || 0);
    kpiErr.textContent = total > 0 ? ((today.tool_errors || 0) / total * 100).toFixed(1) + "%" : "0%";
    kpiConn.textContent = data.connections ?? 0;

    // Reverse series so chart goes left-to-right
    const labels = series.map(d => d.date).reverse();
    const msgs = series.map(d => d.messages).reverse();
    const tools = series.map(d => d.tool_calls).reverse();

    new Chart(chartCanvas, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Mensajes", data: msgs, backgroundColor: "#2563eb", borderRadius: 4 },
          { label: "Tool Calls", data: tools, backgroundColor: "#16a34a", borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      },
    });
  } catch (err) {
    document.getElementById("kpis").innerHTML = '<div class="error-state">Error al cargar métricas: ' + err.message + '</div>';
    chartCanvas.parentElement.innerHTML = '<div class="error-state">No se pudo cargar el gráfico.</div>';
  }
})();
</script>
</body>
</html>`;
}
