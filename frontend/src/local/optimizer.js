// Ported from backend/app/optimizer.py (scipy linprog). This LP
// (minimise sum(x_i * pain_i) s.t. sum(x_i) >= deficit, 0 <= x_i <= cap_i)
// is solved exactly by filling donors in ascending pain order — no solver needed.

export function capacityPaise(d) {
  if (d.locked || d.balance_paise <= 0) return 0
  return Math.floor((d.balance_paise * d.flexibility_pct) / 100)
}

export function planRebalance(deficitPaise, donors) {
  if (deficitPaise <= 0) {
    return { moves: [], total_pain: 0, pain_score: 0, feasible: true }
  }
  const caps = donors.map(capacityPaise)
  const totalCap = caps.reduce((a, b) => a + b, 0)
  if (totalCap < deficitPaise) {
    return { moves: [], total_pain: 0, pain_score: 0, feasible: false }
  }
  const x = caps.map(() => 0)
  let need = deficitPaise
  const order = donors
    .map((d, i) => i)
    .sort((a, b) => donors[a].pain - donors[b].pain || caps[b] - caps[a])
  for (const i of order) {
    if (need <= 0) break
    const take = Math.min(caps[i], need)
    x[i] = take
    need -= take
  }
  const total = x.reduce((a, b) => a + b, 0)
  const totalPain = donors.reduce((acc, d, i) => acc + x[i] * d.pain, 0)
  const moves = donors
    .map((d, i) => [d.id, x[i]])
    .filter(([, amt]) => amt > 0)
    .sort((a, b) => a[0] - b[0])
  return {
    moves,
    total_pain: totalPain,
    pain_score: Math.round((totalPain / (100 * total)) * 100) / 100,
    feasible: true,
  }
}
