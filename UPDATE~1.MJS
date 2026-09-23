// Carteira Viva — atualizador diário de cotações.
// Roda no GitHub Actions (Node 20+). Usa a SERVICE ROLE key do Supabase
// (segredo, nunca fica no site) para ler/gravar direto no banco, ignorando RLS.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Faltam as variáveis SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const REST = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: "Bearer " + SERVICE_KEY,
  "Content-Type": "application/json",
};

async function sb(path, opts = {}) {
  const res = await fetch(REST + path, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase ${opts.method || "GET"} ${path} -> ${res.status}: ${text}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function toDDMMYYYY(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ---------- Ações / FIIs / Fundos via brapi.dev ----------
async function fetchMarketPrice(ticker) {
  for (const t of [ticker, ticker + ".SA"]) {
    try {
      const res = await fetch(`https://brapi.dev/api/quote/${encodeURIComponent(t)}`);
      if (!res.ok) continue;
      const json = await res.json();
      const price = json?.results?.[0]?.regularMarketPrice;
      if (typeof price === "number" && isFinite(price)) return price;
    } catch {
      // tenta a próxima variante
    }
  }
  return null;
}

// ---------- Cripto via CoinGecko (preço em BRL) ----------
const COINGECKO_IDS = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ADA: "cardano",
  XRP: "ripple", BNB: "binancecoin", DOGE: "dogecoin", LTC: "litecoin",
  MATIC: "matic-network", DOT: "polkadot", USDT: "tether", USDC: "usd-coin",
};
async function fetchCryptoPrice(ticker) {
  const id = COINGECKO_IDS[(ticker || "").toUpperCase()] || (ticker || "").toLowerCase();
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=brl`);
    if (!res.ok) return null;
    const json = await res.json();
    const price = json?.[id]?.brl;
    return typeof price === "number" && isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

// ---------- Renda fixa via séries do Banco Central (SGS) ----------
const SGS_CDI = 12;   // CDI diário, % ao dia
const SGS_IPCA = 433; // IPCA mensal, %

async function fetchSgsSeries(code, startISO, endISO) {
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=${toDDMMYYYY(startISO)}&dataFinal=${toDDMMYYYY(endISO)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return Array.isArray(json) ? json : null;
}

async function computeFixedIncomeValue(h) {
  const principal = Number(h.avg_price) || 0;
  const rate = Number(h.rf_rate) || 0;
  const start = h.purchase_date;
  const today = todayISO();
  if (!start || principal <= 0) return null;

  if (h.rf_indexer === "pre") {
    const days = Math.max(0, (new Date(today) - new Date(start)) / 86400000);
    return principal * Math.pow(1 + rate / 100, days / 365);
  }
  if (h.rf_indexer === "cdi") {
    const series = await fetchSgsSeries(SGS_CDI, start, today);
    if (!series || series.length === 0) return null;
    let factor = 1;
    for (const item of series) factor *= 1 + parseFloat(String(item.valor).replace(",", ".")) / 100;
    return principal * Math.pow(factor, rate / 100);
  }
  if (h.rf_indexer === "ipca") {
    const series = await fetchSgsSeries(SGS_IPCA, start, today);
    if (!series || series.length === 0) return null;
    let factor = 1;
    for (const item of series) factor *= 1 + parseFloat(String(item.valor).replace(",", ".")) / 100;
    const months = series.length;
    return principal * factor * Math.pow(1 + rate / 100, months / 12);
  }
  return null;
}

async function main() {
  const holdings = await sb("/holdings?select=*");
  console.log(`Encontrados ${holdings.length} ativo(s).`);

  let updated = 0, skipped = 0;
  const now = new Date().toISOString();

  for (const h of holdings) {
    let newPrice = null;
    try {
      if (h.type === "acoes" || h.type === "fiis" || h.type === "fundos") {
        newPrice = await fetchMarketPrice((h.ticker || h.name || "").trim());
      } else if (h.type === "outros") {
        newPrice = await fetchCryptoPrice((h.ticker || h.name || "").trim());
      } else if (h.type === "renda_fixa") {
        newPrice = await computeFixedIncomeValue(h);
      }
    } catch (err) {
      console.warn(`Falhou ${h.name}: ${err.message}`);
    }

    if (newPrice == null || !isFinite(newPrice) || newPrice <= 0) {
      skipped++;
      console.log(`- pulado: ${h.name} (${h.type})`);
      continue;
    }

    await sb(`/holdings?id=eq.${h.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ current_price: newPrice, price_updated_at: now }),
    });
    updated++;
    console.log(`- atualizado: ${h.name} -> R$ ${newPrice.toFixed(2)}`);
  }

  // Recalcula totais por usuário e grava um ponto no histórico do dia.
  const refreshed = await sb("/holdings?select=user_id,quantity,avg_price,current_price");
  const byUser = new Map();
  for (const h of refreshed) {
    const acc = byUser.get(h.user_id) || { invested: 0, current: 0 };
    acc.invested += (Number(h.quantity) || 0) * (Number(h.avg_price) || 0);
    acc.current += (Number(h.quantity) || 0) * (Number(h.current_price) || 0);
    byUser.set(h.user_id, acc);
  }
  const today = todayISO();
  for (const [userId, totals] of byUser) {
    await sb("/history?on_conflict=user_id,date", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        user_id: userId, date: today,
        total_invested: totals.invested, total_current: totals.current,
      }]),
    });
  }

  console.log(`Concluído: ${updated} atualizado(s), ${skipped} pulado(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
